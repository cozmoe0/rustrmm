//! The agent side of a Windows desktop session: consent, helper launch and supervision, the pipe
//! ⇄ tunnel relay, and Ctrl+Alt+Del (`SendSAS`, which only the service may call).

use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use base64::Engine as _;
use futures::{SinkExt, StreamExt};
use rustrmm_proto::desktop::{
    ConsentStatus, DesktopControl, Media, Quality, Screenshot, consent_prompt,
};
use serde_json::{Value, json};
use tokio::net::windows::named_pipe::NamedPipeServer;
use tokio_tungstenite::tungstenite::Message as WsMessage;

use super::launch::{self, Helper};
use super::{pipe, session};
use crate::desktop::ipc::{self, HelperConfig};
use crate::desktop::{Params, Sink, Stream, control};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_RESTARTS: u32 = 5;

fn as_service() -> bool {
    crate::service::running_as_service()
}

/// The session to show: the requested one (service), the console session (service, default) or
/// the agent's own session (dev mode).
fn target_session(requested: Option<u32>) -> Result<u32> {
    if !as_service() {
        let own = session::own_session();
        if requested.is_some_and(|s| s != own) {
            bail!("in development mode only the agent's own session can be shown");
        }
        return Ok(own);
    }
    match requested {
        Some(0) => bail!("session 0 has no interactive desktop"),
        Some(s) => Ok(s),
        None => session::console_session().context("No interactive session"),
    }
}

/// The helper binary: always the installed agent when running as a service.
fn helper_exe() -> Result<std::path::PathBuf> {
    let current = std::env::current_exe()?;
    if !as_service() {
        return Ok(current);
    }
    let installed = crate::paths::Paths::resolve(None).installed_binary();
    let same = current.canonicalize().ok() == installed.canonicalize().ok() && installed.is_file();
    if !same {
        bail!(
            "the desktop helper is launched only from the installed agent ({})",
            installed.display()
        );
    }
    Ok(installed)
}

/// Starts a helper in `session`, waits for it to connect, verifies it and sends `config`.
async fn start_helper(session: u32, config: &HelperConfig) -> Result<(Helper, NamedPipeServer)> {
    let exe = helper_exe()?;
    let name = pipe::new_name();
    let server = pipe::create_server(&name, as_service())?;
    let helper = if as_service() {
        launch::spawn_system_in_session(&exe, session, &name)?
    } else {
        launch::spawn_dev(&exe, session, &name)?
    };
    let deadline = Instant::now() + CONNECT_TIMEOUT;
    let connected = loop {
        match tokio::time::timeout(Duration::from_millis(200), server.connect()).await {
            Ok(result) => break result.context("pipe connect"),
            Err(_) if helper.has_exited() => {
                break Err(anyhow::anyhow!(
                    "the desktop helper exited before connecting"
                ));
            }
            Err(_) if Instant::now() > deadline => {
                break Err(anyhow::anyhow!(
                    "the desktop helper did not connect in time"
                ));
            }
            Err(_) => {}
        }
    };
    if let Err(e) = connected.and_then(|()| pipe::verify_client(&server, helper.pid, session, &exe))
    {
        tokio::task::spawn_blocking(move || helper.finish(0))
            .await
            .ok();
        return Err(e);
    }
    let mut server = server;
    ipc::write(&mut server, ipc::CONFIG, &serde_json::to_vec(config)?).await?;
    Ok((helper, server))
}

/// Applies the consent rules; `Some(status)` when the session may not start.
async fn consent(
    sink: Option<&mut Sink>,
    session: u32,
    mode: rustrmm_proto::desktop::ConsentMode,
    timeout_secs: u32,
    prompt: String,
) -> Result<ConsentStatus> {
    if !tokio::task::spawn_blocking(move || session::consent_needed(mode, session)).await? {
        return Ok(ConsentStatus::NotRequired);
    }
    let mut sink = sink;
    if let Some(s) = sink.as_deref_mut() {
        control(
            s,
            &DesktopControl::Consent {
                status: ConsentStatus::Waiting,
            },
        )
        .await?;
    }
    let status =
        tokio::task::spawn_blocking(move || session::ask_consent(session, &prompt, timeout_secs))
            .await?;
    if let Some(s) = sink {
        control(s, &DesktopControl::Consent { status }).await?;
    }
    Ok(status)
}

enum End {
    Operator,
    HelperDone,
    HelperDied,
}

/// Serves a desktop tunnel on Windows.
pub async fn serve(sink: &mut Sink, stream: &mut Stream, params: Params) -> Result<()> {
    let mut session_id = target_session(params.session_id)?;
    let status = consent(
        Some(sink),
        session_id,
        params.consent,
        params.consent_timeout_secs,
        consent_prompt(&params.technician, &params.organization, false),
    )
    .await?;
    if !status.allows() {
        control(sink, &DesktopControl::Exit { code: None }).await?;
        return Ok(());
    }
    let mut config = HelperConfig {
        mode: "stream".into(),
        monitor: params.monitor,
        view_only: params.view_only,
        quality: params.quality,
        banner: params.banner,
        technician: params.technician.clone(),
        max_width: 0,
    };
    let mut restarts = 0u32;
    loop {
        let (helper, server) = match start_helper(session_id, &config).await {
            Ok(started) => started,
            Err(e) if restarts == 0 => return Err(e),
            Err(e) => {
                tracing::warn!(error = %format!("{e:#}"), "desktop helper restart failed");
                restarts += 1;
                if restarts > MAX_RESTARTS {
                    return Err(e);
                }
                tokio::time::sleep(Duration::from_millis(500 << restarts.min(4))).await;
                if params.session_id.is_none() {
                    session_id = target_session(None)?;
                }
                continue;
            }
        };
        tracing::info!(
            session = session_id,
            pid = helper.pid,
            "desktop helper connected"
        );
        let (mut pipe_read, mut pipe_write) = tokio::io::split(server);
        let end = loop {
            tokio::select! {
                frame = ipc::read(&mut pipe_read) => match frame {
                    Ok(Some((ipc::MEDIA, payload))) => sink.send(WsMessage::Binary(payload.into())).await?,
                    Ok(Some((ipc::CONTROL, payload))) => {
                        let text = String::from_utf8_lossy(&payload).to_string();
                        let exit = matches!(serde_json::from_str(&text), Ok(DesktopControl::Exit { .. }));
                        sink.send(WsMessage::Text(text.into())).await?;
                        if exit {
                            break End::HelperDone;
                        }
                    }
                    Ok(Some((ipc::LOG, payload))) => {
                        tracing::info!(target: "desktop_helper", "{}", String::from_utf8_lossy(&payload));
                    }
                    Ok(Some(_)) => {}
                    Ok(None) | Err(_) => break End::HelperDied,
                },
                incoming = stream.next() => match incoming {
                    Some(Ok(WsMessage::Text(text))) => {
                        let Ok(message) = serde_json::from_str::<DesktopControl>(&text) else { continue };
                        match message {
                            DesktopControl::Cad if !config.view_only => {
                                let service = as_service();
                                if let Err(e) = tokio::task::spawn_blocking(move || session::send_sas(service)).await? {
                                    control(sink, &DesktopControl::Error { message: format!("{e:#}") }).await?;
                                }
                                continue;
                            }
                            DesktopControl::ViewOnly { value } => config.view_only = value,
                            ref m if m.is_input() && config.view_only => continue,
                            DesktopControl::Quality { value } => config.quality = value,
                            DesktopControl::Monitor { id } => config.monitor = Some(id),
                            _ => {}
                        }
                        if ipc::write(&mut pipe_write, ipc::CONTROL, text.as_bytes()).await.is_err() {
                            break End::HelperDied;
                        }
                    }
                    Some(Ok(WsMessage::Close(_))) | None | Some(Err(_)) => break End::Operator,
                    Some(Ok(_)) => {}
                },
            }
        };
        drop(pipe_read);
        drop(pipe_write);
        tokio::task::spawn_blocking(move || helper.finish(2000))
            .await
            .ok();
        match end {
            End::Operator | End::HelperDone => return Ok(()),
            End::HelperDied => {
                restarts += 1;
                if restarts > MAX_RESTARTS {
                    bail!("the desktop helper keeps exiting");
                }
                tracing::info!(restarts, "desktop helper exited; restarting");
                tokio::time::sleep(Duration::from_millis(500 << restarts.min(4))).await;
                if params.session_id.is_none() {
                    session_id = target_session(None)?;
                }
            }
        }
    }
}

/// One screenshot of the console session's primary monitor, through a helper.
pub async fn screenshot(request: Screenshot) -> Result<Value> {
    let session_id = target_session(None)?;
    let status = consent(
        None,
        session_id,
        request.consent,
        request.consent_timeout_secs,
        consent_prompt(&request.technician, &request.organization, true),
    )
    .await?;
    match status {
        ConsentStatus::Denied => bail!("The user denied the screenshot"),
        ConsentStatus::Timeout => bail!("The user did not answer the consent prompt"),
        _ => {}
    }
    let config = HelperConfig {
        mode: "screenshot".into(),
        monitor: None,
        view_only: true,
        quality: Quality::Auto,
        banner: false,
        technician: String::new(),
        max_width: request.max_width,
    };
    let (helper, mut server) = start_helper(session_id, &config).await?;
    let result = tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            match ipc::read(&mut server).await? {
                Some((ipc::SCREENSHOT, payload)) => {
                    let (w, h, jpeg) =
                        ipc::parse_screenshot(&payload).context("malformed screenshot")?;
                    return Ok::<_, anyhow::Error>(json!({
                        "jpeg": base64::engine::general_purpose::STANDARD.encode(jpeg),
                        "width": w,
                        "height": h,
                        "consent": status.as_str(),
                    }));
                }
                Some((ipc::CONTROL, payload)) => {
                    if let Ok(DesktopControl::Error { message }) = serde_json::from_slice(&payload)
                    {
                        bail!("{message}");
                    }
                }
                Some(_) => {}
                None => bail!("the desktop helper exited without a screenshot"),
            }
        }
    })
    .await;
    drop(server);
    tokio::task::spawn_blocking(move || helper.finish(2000))
        .await
        .ok();
    result.context("the screenshot timed out")?
}

/// `rustrmm-agent desktop-bench`: drives a real helper (dev mode) like a viewer that acks every
/// frame and prints the throughput. By default it asks for a full refresh after every frame
/// (worst case); `incremental` only acks, so frames carry DXGI dirty regions for up to 10 s.
pub async fn bench(frames: u32, quality: Quality, incremental: bool) -> Result<()> {
    let session_id = target_session(None)?;
    let config = HelperConfig {
        mode: "stream".into(),
        monitor: None,
        view_only: true,
        quality,
        banner: false,
        technician: String::new(),
        max_width: 0,
    };
    let started = Instant::now();
    let (helper, server) = start_helper(session_id, &config).await?;
    println!(
        "helper pid {} connected in {} ms",
        helper.pid,
        started.elapsed().as_millis()
    );
    let (mut read, mut write) = tokio::io::split(server);
    let mut count = 0u32;
    let mut bytes = 0u64;
    let mut first: Option<Instant> = None;
    let window = if incremental {
        Duration::from_secs(10)
    } else {
        Duration::from_secs(120)
    };
    let result = tokio::time::timeout(Duration::from_secs(130), async {
        while count < frames && first.is_none_or(|t| t.elapsed() < window) {
            let next = tokio::time::timeout(Duration::from_millis(500), ipc::read(&mut read)).await;
            let Ok(next) = next else { continue };
            let Some((kind, payload)) = next? else {
                bail!("helper exited");
            };
            match kind {
                ipc::MEDIA => {
                    bytes += payload.len() as u64;
                    if let Ok(Media::FrameEnd { frame_seq, tiles }) = Media::decode(&payload) {
                        if first.is_none() {
                            first = Some(Instant::now());
                            println!(
                                "first frame: {tiles} tiles, {} KiB, {} ms after start",
                                bytes / 1024,
                                started.elapsed().as_millis()
                            );
                            bytes = 0;
                        } else {
                            count += 1;
                        }
                        let ack = DesktopControl::Ack { frame_seq }.to_text();
                        ipc::write(&mut write, ipc::CONTROL, ack.as_bytes()).await?;
                        if !incremental {
                            ipc::write(
                                &mut write,
                                ipc::CONTROL,
                                DesktopControl::Refresh.to_text().as_bytes(),
                            )
                            .await?;
                        } else if count > 0 {
                            println!("frame {frame_seq}: {tiles} tiles");
                        }
                    }
                }
                ipc::CONTROL => {
                    let text = String::from_utf8_lossy(&payload);
                    if text.contains("\"ready\"")
                        || text.contains("\"stats\"")
                        || text.contains("\"error\"")
                    {
                        println!("{}", text.chars().take(240).collect::<String>());
                    }
                }
                _ => {}
            }
        }
        Ok(())
    })
    .await;
    drop(read);
    drop(write);
    tokio::task::spawn_blocking(move || helper.finish(2000))
        .await
        .ok();
    result.context("bench timed out")??;
    let secs = first
        .map(|t| t.elapsed().as_secs_f64())
        .unwrap_or(1.0)
        .max(0.001);
    println!(
        "{count} {} frames in {secs:.2} s: {:.1} fps, {:.0} kbps, {:.0} KiB per frame",
        if incremental { "incremental" } else { "full" },
        f64::from(count) / secs,
        bytes as f64 * 8.0 / 1000.0 / secs,
        bytes as f64 / 1024.0 / f64::from(count.max(1))
    );
    Ok(())
}
