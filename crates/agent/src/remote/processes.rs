//! Process list and termination.

use std::time::Duration;

use anyhow::{Result, bail};
use serde_json::{Value, json};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind, Users};

pub fn list() -> Result<Value> {
    let mut system = System::new()?;
    let kind = ProcessRefreshKind::nothing()
        .with_cpu()
        .with_memory()
        .with_user(UpdateKind::OnlyIfNotSet)
        .with_exe(UpdateKind::OnlyIfNotSet);
    system.refresh_processes_specifics(ProcessesToUpdate::All, true, kind);
    // CPU usage is a delta between two refreshes.
    std::thread::sleep(sysinfo::MINIMUM_CPU_UPDATE_INTERVAL.max(Duration::from_millis(250)));
    system.refresh_processes_specifics(ProcessesToUpdate::All, true, kind);
    let users = Users::new_with_refreshed_list().ok();
    let cpus = System::physical_core_count().unwrap_or(1).max(1) as f32;
    let logical = std::thread::available_parallelism()
        .map(|n| n.get() as f32)
        .unwrap_or(cpus);

    let mut items: Vec<Value> = system
        .processes()
        .values()
        .map(|p| {
            let user = p.user_id().and_then(|uid| {
                users
                    .as_ref()
                    .and_then(|u| u.get_user_by_id(uid))
                    .map(|u| u.name().to_string())
            });
            json!({
                "pid": p.pid().as_u32(),
                "parent": p.parent().map(|pp| pp.as_u32()),
                "name": p.name().to_string_lossy(),
                "exe": p.exe().map(|e| e.display().to_string()),
                "user": user,
                // Normalised to 0–100 % of the whole machine.
                "cpu": (f64::from(p.cpu_usage()) / f64::from(logical) * 100.0).round() / 100.0,
                "memory": p.memory(),
                "started_at": p.start_time(),
                "status": p.status().to_string(),
            })
        })
        .collect();
    items.sort_by(|a, b| {
        b["cpu"]
            .as_f64()
            .unwrap_or(0.0)
            .total_cmp(&a["cpu"].as_f64().unwrap_or(0.0))
            .then_with(|| b["memory"].as_u64().cmp(&a["memory"].as_u64()))
    });
    Ok(json!({ "items": items, "count": items.len() }))
}

pub fn kill(pid: u32, tree: bool) -> Result<Value> {
    if pid == 0 || pid == 4 || pid == std::process::id() {
        bail!("refusing to terminate process {pid}");
    }
    let mut system = System::new()?;
    system.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
    let target = Pid::from_u32(pid);
    let Some(process) = system.process(target) else {
        bail!("process {pid} is not running");
    };
    let name = process.name().to_string_lossy().to_string();
    let mut victims = vec![target];
    if tree {
        // Breadth-first collection of descendants.
        let mut i = 0;
        while i < victims.len() {
            let parent = victims[i];
            victims.extend(
                system
                    .processes()
                    .values()
                    .filter(|p| p.parent() == Some(parent) && p.pid() != parent)
                    .map(|p| p.pid()),
            );
            i += 1;
            if victims.len() > 4096 {
                break;
            }
        }
    }
    let mut killed = 0usize;
    // Children first so nothing respawns from a dying parent.
    for pid in victims.iter().rev() {
        if let Some(p) = system.process(*pid)
            && p.kill()
        {
            killed += 1;
        }
    }
    if killed == 0 {
        bail!("could not terminate {name} ({pid})");
    }
    Ok(json!({ "pid": pid, "name": name, "terminated": killed }))
}
