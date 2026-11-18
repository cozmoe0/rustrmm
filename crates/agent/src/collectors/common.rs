//! Cross-platform facts from `sysinfo`; platform modules enrich the same documents.

use serde_json::{Map, Value, json};
use sysinfo::{Disks, Networks, System};

pub fn system(doc: &mut Map<String, Value>) {
    let hostname = hostname::get()
        .map(|h| h.to_string_lossy().to_string())
        .unwrap_or_default();
    let boot = System::boot_time().ok();
    doc.insert("hostname".into(), json!(hostname));
    doc.insert(
        "os".into(),
        json!({
            "family": super::os_family(),
            "name": System::long_os_version().or_else(|_| System::name()).unwrap_or_default(),
            "version": System::os_version().unwrap_or_default(),
            "kernel": System::kernel_version().unwrap_or_default(),
            "distribution": System::distribution_id(),
        }),
    );
    doc.insert("arch".into(), json!(System::cpu_arch()));
    doc.insert(
        "boot_time".into(),
        json!(
            boot.and_then(|b| chrono::DateTime::<chrono::Utc>::from_timestamp(b as i64, 0))
                .map(|t| t.to_rfc3339())
        ),
    );
    doc.insert(
        "utc_offset_minutes".into(),
        json!(chrono::Local::now().offset().local_minus_utc() / 60),
    );
    doc.insert("agent_version".into(), json!(crate::AGENT_VERSION));
}

pub fn hardware(doc: &mut Map<String, Value>) {
    let mut system = match System::new() {
        Ok(s) => s,
        Err(_) => return,
    };
    system.refresh_cpu_all();
    system.refresh_memory();
    let cpus = system.cpus();
    let first = cpus.first();
    doc.insert(
        "cpu".into(),
        json!({
            "model": first.map(|c| c.brand().trim().to_string()).unwrap_or_default(),
            "vendor": first.map(|c| c.vendor_id().to_string()).unwrap_or_default(),
            "cores": System::physical_core_count().ok(),
            "threads": cpus.len(),
            "mhz": first.map(|c| c.frequency()),
        }),
    );
    doc.insert(
        "memory".into(),
        json!({ "total_bytes": system.total_memory() }),
    );
}

pub fn storage(doc: &mut Map<String, Value>) {
    let Ok(disks) = Disks::new_with_refreshed_list() else {
        return;
    };
    let volumes: Vec<Value> = disks
        .iter()
        .filter(|d| d.total_space() > 0)
        .map(|d| {
            json!({
                "mount": d.mount_point().to_string_lossy(),
                "name": d.name().to_string_lossy(),
                "filesystem": d.file_system().to_string_lossy(),
                "total_bytes": d.total_space(),
                "free_bytes": d.available_space(),
                "kind": format!("{:?}", d.kind()).to_lowercase(),
                "removable": d.is_removable(),
                "read_only": d.is_read_only(),
            })
        })
        .collect();
    doc.insert("volumes".into(), Value::Array(volumes));
}

pub fn network(doc: &mut Map<String, Value>) {
    let Ok(networks) = Networks::new_with_refreshed_list() else {
        return;
    };
    let mut interfaces: Vec<Value> = networks
        .iter()
        .filter(|(_, n)| !n.ip_networks().is_empty())
        .map(|(name, n)| {
            let (v4, v6): (Vec<&sysinfo::IpNetwork>, Vec<&sysinfo::IpNetwork>) = n.ip_networks().iter().partition(|ip| ip.addr.is_ipv4());
            json!({
                "name": name.to_string_lossy(),
                "mac": n.mac_address().to_string(),
                "ipv4": v4.iter().map(|ip| format!("{}/{}", ip.addr, ip.prefix)).collect::<Vec<_>>(),
                "ipv6": v6.iter().map(|ip| format!("{}/{}", ip.addr, ip.prefix)).collect::<Vec<_>>(),
                "mtu": n.mtu(),
                "speed_mbps": n.receive_link_speed().map(|bps| bps / 1_000_000),
            })
        })
        .collect();
    interfaces.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    doc.insert("interfaces".into(), Value::Array(interfaces));
}
