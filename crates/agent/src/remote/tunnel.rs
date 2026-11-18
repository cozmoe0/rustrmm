//! Tunnel client: dials `/agent/v1/tunnel/{id}` for a shell or a file transfer.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use futures::{SinkExt, StreamExt};
use rustrmm_proto::noise::{self, tungstenite::NoiseSocket};
use rustrmm_proto::remote::{
    MAX_TUNNEL_TO_AGENT, OpenTunnel, TUNNEL_TOKEN_HEADER, TunnelControl, TunnelKind,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;

use super::files;

type RawWs =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;
/// A tunnel socket, Noise-wrapped when the control connection uses the end-to-end channel.
pub(crate) type Ws = NoiseSocket<RawWs>;

const CHUNK: usize = 64 * 1024;

/// Connects the tunnel socket. Errors before this point are reported through the command result.
pub async fn connect(
    base_url: &str,
    tls: Arc<rustls::ClientConfig>,
    open: &OpenTunnel,
    noise_keys: Option<&crate::connection::TunnelNoise>,
) -> Result<Ws> {
    let mut url = url::Url::parse(base_url).context("invalid server URL")?;
    url.set_scheme("wss")
        .map_err(|_| anyhow::anyhow!("cannot use wss with {base_url}"))?;
    url.set_path(&format!("/agent/v1/tunnel/{}", open.tunnel_id));
    let mut request = url.as_str().into_client_request()?;
    request.headers_mut().insert(
        TUNNEL_TOKEN_HEADER,
        open.token.parse().context("invalid tunnel token")?,
    );
    let mut config = WebSocketConfig::default();
    config.max_message_size = Some(noise::sealed_len(MAX_TUNNEL_TO_AGENT));
    let (mut ws, _) = tokio::time::timeout(
        Duration::from_secs(20),
        tokio_tungstenite::connect_async_tls_with_config(
            request,
            Some(config),
            false,
            Some(tokio_tungstenite::Connector::Rustls(tls)),
        ),
    )
    .await
    .context("tunnel connect timed out")??;
    let Some(keys) = noise_keys else {
        return Ok(Ws::new(ws, None));
    };
    // Same static keys as the control connection, prologue bound to this tunnel.
    let (initiator, first) = noise::Initiator::start(
        &keys.local,
        &keys.server,
        &noise::tunnel_prologue(&open.tunnel_id),
    )?;
    ws.send(WsMessage::Binary(first.into())).await?;
    let reply = loop {
        match tokio::time::timeout(Duration::from_secs(20), ws.next())
            .await
            .context("tunnel handshake timed out")?
        {
            Some(Ok(WsMessage::Binary(bytes))) => break bytes,
            Some(Ok(WsMessage::Ping(_) | WsMessage::Pong(_) | WsMessage::Frame(_))) => continue,
            Some(Ok(_)) | None => bail!("the server closed the tunnel during the handshake"),
            Some(Err(e)) => return Err(e.into()),
        }
    };
    let codec = initiator.finish(&reply)?;
    Ok(Ws::new(ws, Some(codec)))
}

/// Runs the tunnel until either side ends it.
pub async fn serve(ws: Ws, kind: TunnelKind) {
    let (mut sink, mut stream) = ws.split();
    let outcome = match kind {
        TunnelKind::Shell { shell, cols, rows } => {
            shell_session(&mut sink, &mut stream, &shell, cols, rows).await
        }
        TunnelKind::Download { path } => download(&mut sink, &mut stream, &path).await,
        TunnelKind::Upload {
            path,
            size,
            overwrite,
        } => upload(&mut sink, &mut stream, &path, size, overwrite).await,
        desktop @ TunnelKind::Desktop { .. } => match crate::desktop::Params::from_kind(desktop) {
            Some(params) => crate::desktop::serve(&mut sink, &mut stream, params).await,
            None => Ok(()),
        },
    };
    if let Err(e) = outcome {
        tracing::warn!(error = %format!("{e:#}"), "tunnel ended with an error");
        let _ = sink
            .send(WsMessage::Text(
                TunnelControl::Error {
                    message: format!("{e:#}"),
                }
                .to_text()
                .into(),
            ))
            .await;
    }
    let _ = sink.close().await;
}

pub(crate) type Sink = futures::stream::SplitSink<Ws, WsMessage>;
pub(crate) type Stream = futures::stream::SplitStream<Ws>;

async fn control(sink: &mut Sink, msg: TunnelControl) -> Result<()> {
    sink.send(WsMessage::Text(msg.to_text().into())).await?;
    Ok(())
}

async fn shell_session(
    sink: &mut Sink,
    stream: &mut Stream,
    shell: &str,
    cols: u16,
    rows: u16,
) -> Result<()> {
    let (program, args) = crate::pty::resolve_shell(shell)?;
    tracing::info!(shell = %program.display(), "opening remote shell");
    let (pty, mut output, mut exit) = tokio::task::spawn_blocking(move || {
        crate::pty::PtySession::spawn(&program, &args, cols, rows)
    })
    .await??;
    control(sink, TunnelControl::Ready).await?;

    let result: Result<Option<i64>> = async {
        loop {
            tokio::select! {
                chunk = output.recv() => match chunk {
                    Some(bytes) => sink.send(WsMessage::Binary(bytes.into())).await?,
                    None => return Ok(None),
                },
                code = &mut exit => {
                    // Flush what conhost/the PTY still holds before reporting the exit.
                    let deadline = tokio::time::Instant::now() + Duration::from_millis(300);
                    while let Ok(Some(bytes)) = tokio::time::timeout_at(deadline, output.recv()).await {
                        sink.send(WsMessage::Binary(bytes.into())).await?;
                    }
                    return Ok(code.ok());
                }
                incoming = stream.next() => match incoming {
                    Some(Ok(WsMessage::Binary(bytes))) => pty.write(bytes.to_vec()),
                    Some(Ok(WsMessage::Text(text))) => {
                        if let Ok(TunnelControl::Resize { cols, rows }) = serde_json::from_str(&text) {
                            let _ = pty.resize(cols, rows);
                        }
                    }
                    Some(Ok(WsMessage::Close(_))) | None => return Ok(None),
                    Some(Ok(_)) => {}
                    Some(Err(e)) => return Err(e.into()),
                },
            }
        }
    }
    .await;
    tokio::task::spawn_blocking(move || pty.close()).await.ok();
    let code = result?;
    let _ = control(sink, TunnelControl::Exit { code }).await;
    tracing::info!(?code, "remote shell closed");
    Ok(())
}

async fn download(sink: &mut Sink, stream: &mut Stream, path: &str) -> Result<()> {
    let path = files::absolute(path)?;
    let meta = tokio::fs::metadata(&path)
        .await
        .with_context(|| format!("{} does not exist", path.display()))?;
    if meta.is_dir() {
        bail!("{} is a folder", path.display());
    }
    let mut file = tokio::fs::File::open(&path)
        .await
        .with_context(|| format!("cannot open {}", path.display()))?;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "download".into());
    control(
        sink,
        TunnelControl::Meta {
            name,
            size: meta.len(),
        },
    )
    .await?;
    let mut buf = vec![0u8; CHUNK];
    loop {
        let n = file.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        sink.send(WsMessage::Binary(buf[..n].to_vec().into()))
            .await?;
    }
    control(sink, TunnelControl::Eof).await?;
    // Wait briefly for the server to acknowledge by closing.
    let _ = tokio::time::timeout(Duration::from_secs(10), stream.next()).await;
    Ok(())
}

async fn upload(
    sink: &mut Sink,
    stream: &mut Stream,
    path: &str,
    size: u64,
    overwrite: bool,
) -> Result<()> {
    let target = files::absolute(path)?;
    files::guard(&target)?;
    if target.is_dir() {
        bail!("{} is a folder", target.display());
    }
    if target.exists() && !overwrite {
        bail!("{} already exists", target.display());
    }
    let name = target
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .context("missing file name")?;
    let partial: PathBuf = target.with_file_name(format!(".{name}.rustrmm-part"));
    let mut file = tokio::fs::File::create(&partial)
        .await
        .with_context(|| format!("cannot write to {}", partial.display()))?;
    control(sink, TunnelControl::Ready).await?;
    let mut received: u64 = 0;
    let outcome: Result<()> = async {
        loop {
            match tokio::time::timeout(Duration::from_secs(120), stream.next()).await {
                Err(_) => bail!("upload stalled"),
                Ok(Some(Ok(WsMessage::Binary(bytes)))) => {
                    received += bytes.len() as u64;
                    if received > size {
                        bail!("upload is larger than announced");
                    }
                    file.write_all(&bytes).await?;
                }
                Ok(Some(Ok(WsMessage::Text(text)))) => {
                    if matches!(serde_json::from_str(&text), Ok(TunnelControl::Eof)) {
                        break;
                    }
                }
                Ok(Some(Ok(WsMessage::Close(_)))) | Ok(None) => bail!("upload interrupted"),
                Ok(Some(Ok(_))) => {}
                Ok(Some(Err(e))) => return Err(e.into()),
            }
        }
        if received != size {
            bail!("upload incomplete ({received} of {size} bytes)");
        }
        file.flush().await?;
        file.sync_all().await?;
        Ok(())
    }
    .await;
    drop(file);
    if let Err(e) = outcome {
        let _ = tokio::fs::remove_file(&partial).await;
        return Err(e);
    }
    tokio::fs::rename(&partial, &target)
        .await
        .with_context(|| format!("cannot replace {}", target.display()))?;
    control(sink, TunnelControl::Done { bytes: received }).await?;
    let _ = tokio::time::timeout(Duration::from_secs(10), stream.next()).await;
    Ok(())
}
