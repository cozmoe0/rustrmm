//! Windows Update Agent through its COM API (`Microsoft.Update.Session`), always on a dedicated
//! MTA thread. WSUS settings apply automatically because WUA reads them itself.

use std::collections::HashSet;

use anyhow::{Context, Result, anyhow};
use rustrmm_proto::patching::{AgentPatch, PatchKeyResult, PatchScan};
use windows::Win32::System::Com::{
    CLSCTX_ALL, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx, CoUninitialize,
};
use windows::Win32::System::UpdateAgent::{
    IUpdate, IUpdate2, IUpdateCollection, IUpdateSearcher, IUpdateSession, UpdateCollection,
    UpdateSession, utDriver,
};
use windows::core::{BSTR, IUnknown, Interface};

use super::parsers::{kb_from_title, ole_date, wua_pick_classification, wua_severity};

const CLIENT_ID: &str = "RustRMM";

struct ComApartment;

impl Drop for ComApartment {
    fn drop(&mut self) {
        // SAFETY: paired with the successful CoInitializeEx on this thread.
        unsafe { CoUninitialize() };
    }
}

/// Runs `f` on a fresh thread joined to the multithreaded apartment.
fn on_mta<T: Send + 'static>(f: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
    std::thread::Builder::new()
        .name("wua".into())
        .spawn(move || {
            // SAFETY: first COM call on this new thread.
            unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }
                .ok()
                .context("CoInitializeEx")?;
            let _apartment = ComApartment;
            f()
        })
        .context("starting the Windows Update thread")?
        .join()
        .map_err(|_| anyhow!("the Windows Update thread panicked"))?
}

fn session() -> Result<IUpdateSession> {
    // SAFETY: COM is initialised on this thread; the class id is the WUA session.
    let session: IUpdateSession =
        unsafe { CoCreateInstance(&UpdateSession, None::<&IUnknown>, CLSCTX_ALL) }
            .context("creating Microsoft.Update.Session")?;
    // SAFETY: valid interface.
    unsafe { session.SetClientApplicationID(&BSTR::from(CLIENT_ID)) }.ok();
    Ok(session)
}

fn criteria(include_drivers: bool) -> BSTR {
    if include_drivers {
        BSTR::from("IsInstalled=0 and IsHidden=0")
    } else {
        BSTR::from("IsInstalled=0 and IsHidden=0 and Type='Software'")
    }
}

fn strings(
    collection: windows::core::Result<windows::Win32::System::UpdateAgent::IStringCollection>,
) -> Vec<String> {
    let Ok(collection) = collection else {
        return Vec::new();
    };
    // SAFETY: valid collection; indexes are within Count.
    let count = unsafe { collection.Count() }.unwrap_or(0);
    (0..count)
        .filter_map(|i| unsafe { collection.get_Item(i) }.ok())
        .map(|s| s.to_string())
        .collect()
}

fn update_id(update: &IUpdate) -> Option<String> {
    // SAFETY: valid interface.
    unsafe { update.Identity().and_then(|i| i.UpdateID()) }
        .ok()
        .map(|s| s.to_string().to_ascii_lowercase())
}

fn to_patch(update: &IUpdate) -> Option<AgentPatch> {
    let key = update_id(update)?;
    // SAFETY: every call below is a property read on a valid interface.
    unsafe {
        let title = update.Title().map(|t| t.to_string()).unwrap_or_default();
        let mut categories = Vec::new();
        if let Ok(list) = update.Categories() {
            let count = list.Count().unwrap_or(0);
            for i in 0..count {
                if let Ok(category) = list.get_Item(i) {
                    categories.push((
                        category.Type().map(|s| s.to_string()).unwrap_or_default(),
                        category
                            .CategoryID()
                            .map(|s| s.to_string())
                            .unwrap_or_default(),
                        category.Name().map(|s| s.to_string()).unwrap_or_default(),
                    ));
                }
            }
        }
        let is_driver = update.Type().is_ok_and(|t| t == utDriver);
        let size = update
            .MaxDownloadSize()
            .ok()
            .map(|d| d.Anonymous2.Lo64)
            .filter(|s| *s > 0);
        let kb = strings(update.KBArticleIDs())
            .into_iter()
            .next()
            .map(|k| format!("KB{}", k.trim_start_matches("KB")))
            .or_else(|| kb_from_title(&title));
        let update2: Option<IUpdate2> = update.cast().ok();
        let cves = update2
            .as_ref()
            .map(|u| strings(u.CveIDs()))
            .unwrap_or_default();
        let reboot = update
            .InstallationBehavior()
            .and_then(|b| b.RebootBehavior())
            .map(|r| r.0 != 0)
            .unwrap_or(false);
        Some(AgentPatch {
            key,
            kb,
            classification: wua_pick_classification(&categories, is_driver),
            severity: wua_severity(
                &update
                    .MsrcSeverity()
                    .map(|s| s.to_string())
                    .unwrap_or_default(),
            ),
            size_bytes: size,
            reboot_required: reboot,
            release_date: update.LastDeploymentChangeTime().ok().and_then(ole_date),
            description: update
                .Description()
                .map(|s| s.to_string())
                .unwrap_or_default()
                .chars()
                .take(2000)
                .collect(),
            support_url: update
                .SupportUrl()
                .ok()
                .map(|s| s.to_string())
                .filter(|s| !s.is_empty()),
            cves,
            title,
            ..AgentPatch::default()
        })
    }
}

/// Applies the policy's filters on top of the search criteria.
fn wanted(patch: &AgentPatch, scan: &PatchScan) -> bool {
    if patch.classification == "Upgrades" && !scan.include_feature_updates {
        return false;
    }
    if patch.classification == "Drivers" && !scan.include_drivers {
        return false;
    }
    if !scan.include_preview && patch.title.to_ascii_lowercase().contains("preview") {
        return false;
    }
    true
}

fn search(searcher: &IUpdateSearcher, include_drivers: bool) -> Result<Vec<IUpdate>> {
    // SAFETY: valid searcher; the criteria string outlives the call.
    let result = unsafe { searcher.Search(&criteria(include_drivers)) }
        .context("Windows Update search failed")?;
    // SAFETY: valid result.
    let updates = unsafe { result.Updates() }.context("reading search results")?;
    let count = unsafe { updates.Count() }.unwrap_or(0);
    Ok((0..count)
        .filter_map(|i| unsafe { updates.get_Item(i) }.ok())
        .collect())
}

/// Missing updates and the recent install history.
pub struct WuaScan {
    pub available: Vec<AgentPatch>,
    pub history: Vec<AgentPatch>,
    pub last_install: Option<i64>,
}

pub fn scan(options: PatchScan) -> Result<WuaScan> {
    on_mta(move || {
        let session = session()?;
        // SAFETY: valid session.
        let searcher =
            unsafe { session.CreateUpdateSearcher() }.context("creating the searcher")?;
        tracing::info!(
            drivers = options.include_drivers,
            "searching Windows Update"
        );
        let available: Vec<AgentPatch> = search(&searcher, options.include_drivers)?
            .iter()
            .filter_map(to_patch)
            .filter(|p| wanted(p, &options))
            .collect();
        let (history, last_install) = history(&searcher);
        tracing::info!(count = available.len(), "Windows Update search finished");
        Ok(WuaScan {
            available,
            history,
            last_install,
        })
    })
}

/// The last 100 history entries (installations only).
fn history(searcher: &IUpdateSearcher) -> (Vec<AgentPatch>, Option<i64>) {
    let mut out = Vec::new();
    let mut newest: Option<i64> = None;
    // SAFETY: valid searcher; indexes stay within Count.
    unsafe {
        let total = searcher.GetTotalHistoryCount().unwrap_or(0);
        if total <= 0 {
            return (out, None);
        }
        let Ok(entries) = searcher.QueryHistory(0, total.min(100)) else {
            return (out, None);
        };
        let count = entries.Count().unwrap_or(0);
        for i in 0..count {
            let Ok(entry) = entries.get_Item(i) else {
                continue;
            };
            // 1 = installation, 2 = uninstallation.
            if entry.Operation().map(|o| o.0).unwrap_or(0) != 1 {
                continue;
            }
            let Some(key) = entry
                .UpdateIdentity()
                .and_then(|i| i.UpdateID())
                .ok()
                .map(|s| s.to_string().to_ascii_lowercase())
            else {
                continue;
            };
            let code = entry.ResultCode().map(|c| c.0).unwrap_or(0);
            // 2 = succeeded, 3 = succeeded with errors.
            let succeeded = code == 2 || code == 3;
            let date = entry.Date().ok();
            let installed_at = date.and_then(ole_date);
            if succeeded
                && let Some(t) = installed_at
                    .as_deref()
                    .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
            {
                let ms = t.timestamp_millis();
                newest = Some(newest.map_or(ms, |n| n.max(ms)));
            }
            let title = entry.Title().map(|t| t.to_string()).unwrap_or_default();
            out.push(AgentPatch {
                key,
                kb: kb_from_title(&title),
                classification: "Updates".into(),
                title,
                installed_at,
                result: Some(if succeeded { "succeeded" } else { "failed" }.into()),
                hresult: (!succeeded)
                    .then(|| entry.HResult().ok().map(i64::from))
                    .flatten(),
                ..AgentPatch::default()
            });
        }
    }
    (out, newest)
}

/// Outcome of a WUA install.
pub struct WuaInstall {
    pub results: Vec<PatchKeyResult>,
    pub reboot_required: bool,
}

/// Downloads and installs exactly the updates whose ids are in `keys`.
pub fn install(keys: Vec<String>) -> Result<WuaInstall> {
    on_mta(move || {
        let wanted: HashSet<String> = keys.iter().map(|k| k.to_ascii_lowercase()).collect();
        let session = session()?;
        // SAFETY: valid session.
        let searcher =
            unsafe { session.CreateUpdateSearcher() }.context("creating the searcher")?;
        let found: Vec<IUpdate> = search(&searcher, true)?
            .into_iter()
            .filter(|u| update_id(u).is_some_and(|id| wanted.contains(&id)))
            .collect();
        let found_ids: HashSet<String> = found.iter().filter_map(update_id).collect();
        let mut results: Vec<PatchKeyResult> = keys
            .iter()
            .filter(|k| !found_ids.contains(&k.to_ascii_lowercase()))
            .map(|k| PatchKeyResult {
                key: k.clone(),
                status: "failed".into(),
                hresult: None,
                error: Some("no longer offered by Windows Update (installed or superseded)".into()),
            })
            .collect();
        if found.is_empty() {
            return Ok(WuaInstall {
                results,
                reboot_required: false,
            });
        }
        // SAFETY: COM calls on valid interfaces; the collection owns its references.
        unsafe {
            let collection: IUpdateCollection =
                CoCreateInstance(&UpdateCollection, None::<&IUnknown>, CLSCTX_ALL)
                    .context("creating the update collection")?;
            for update in &found {
                if !update.EulaAccepted().is_ok_and(bool::from) {
                    update.AcceptEula().ok();
                }
                collection.Add(update).context("adding an update")?;
            }
            tracing::info!(count = found.len(), "downloading updates");
            let downloader = session
                .CreateUpdateDownloader()
                .context("creating the downloader")?;
            downloader
                .SetClientApplicationID(&BSTR::from(CLIENT_ID))
                .ok();
            downloader
                .SetUpdates(&collection)
                .context("selecting downloads")?;
            let download = downloader.Download().context("downloading updates")?;
            tracing::info!(
                result = download.ResultCode().map(|c| c.0).unwrap_or(-1),
                "download finished"
            );
            tracing::info!(count = found.len(), "installing updates");
            let installer = session
                .CreateUpdateInstaller()
                .context("creating the installer")?;
            installer
                .SetClientApplicationID(&BSTR::from(CLIENT_ID))
                .ok();
            installer
                .SetUpdates(&collection)
                .context("selecting installs")?;
            let outcome = installer.Install().context("installing updates")?;
            let reboot_required = outcome.RebootRequired().is_ok_and(bool::from);
            for (i, update) in found.iter().enumerate() {
                let key = update_id(update).unwrap_or_default();
                let result = outcome.GetUpdateResult(i as i32);
                let (code, hresult, reboot) = match &result {
                    Ok(r) => (
                        r.ResultCode().map(|c| c.0).unwrap_or(4),
                        r.HResult().unwrap_or(0),
                        r.RebootRequired().is_ok_and(bool::from),
                    ),
                    Err(e) => (4, e.code().0, false),
                };
                let status = match (code, reboot) {
                    (2 | 3, true) => "pending_reboot",
                    (2 | 3, false) => "installed",
                    _ => "failed",
                };
                tracing::info!(update = %key, status, hresult = format!("0x{:08X}", hresult as u32), "update result");
                results.push(PatchKeyResult {
                    key,
                    status: status.into(),
                    hresult: (status == "failed").then_some(i64::from(hresult)),
                    error: (status == "failed")
                        .then(|| "Windows Update reported a failure".to_string()),
                });
            }
            Ok(WuaInstall {
                results,
                reboot_required,
            })
        }
    })
}

/// WSUS when the policy points WUA at an internal server.
pub fn source() -> &'static str {
    use winreg::RegKey;
    use winreg::enums::HKEY_LOCAL_MACHINE;
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let use_wsus: u32 = hklm
        .open_subkey(r"SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU")
        .and_then(|k| k.get_value("UseWUServer"))
        .unwrap_or(0);
    let server: String = hklm
        .open_subkey(r"SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate")
        .and_then(|k| k.get_value("WUServer"))
        .unwrap_or_default();
    if use_wsus == 1 && !server.trim().is_empty() {
        "wsus"
    } else {
        "windows_update"
    }
}
