//! macOS inventory via system_profiler and built-in tools.

use std::time::Duration;

use serde_json::{Map, Value, json};

use super::opt_str;
use crate::util::{run, run_any};

const T: Duration = Duration::from_secs(60);

fn profiler(data_type: &str) -> Value {
    run(
        "system_profiler",
        &["-json", "-detailLevel", "mini", data_type],
        T,
    )
    .and_then(|o| serde_json::from_str::<Value>(&o).ok())
    .and_then(|v| v.get(data_type).cloned())
    .unwrap_or(Value::Null)
}

fn first(value: &Value) -> Value {
    value
        .as_array()
        .and_then(|a| a.first())
        .cloned()
        .unwrap_or(Value::Null)
}

fn trimmed(out: Option<String>) -> Option<String> {
    out.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

pub fn identity() -> (Option<String>, Option<String>, Option<String>) {
    let hw = first(&profiler("SPHardwareDataType"));
    let uuid = hw
        .get("platform_UUID")
        .and_then(Value::as_str)
        .map(str::to_string);
    let serial = hw
        .get("serial_number")
        .and_then(Value::as_str)
        .map(str::to_string);
    let domain = trimmed(run_any("dsconfigad", &["-show"], T)).and_then(|o| {
        o.lines()
            .find(|l| l.contains("Active Directory Domain"))
            .and_then(|l| l.split('=').nth(1))
            .map(|d| d.trim().to_string())
    });
    (uuid, serial, domain)
}

pub fn console_user() -> Option<String> {
    trimmed(run("stat", &["-f%Su", "/dev/console"], T)).filter(|u| u != "root")
}

pub fn system(doc: &mut Map<String, Value>) {
    if let Some(Value::Object(os)) = doc.get_mut("os") {
        if let Some(name) = trimmed(run("sw_vers", &["-productName"], T)) {
            let version = trimmed(run("sw_vers", &["-productVersion"], T)).unwrap_or_default();
            os.insert("name".into(), json!(format!("{name} {version}")));
            os.insert("version".into(), json!(version));
        }
        os.insert(
            "build".into(),
            json!(trimmed(run("sw_vers", &["-buildVersion"], T))),
        );
    }
    let model = first(&profiler("SPHardwareDataType"))
        .get("machine_name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_lowercase();
    let device_type = if model.contains("book") {
        "laptop"
    } else if model.contains("vmware") || model.contains("virtual") {
        "virtual"
    } else {
        "workstation"
    };
    doc.insert("device_type".into(), json!(device_type));
    doc.insert("domain".into(), json!(identity().2));
    let pending = run_any(
        "softwareupdate",
        &["--list", "--no-scan"],
        Duration::from_secs(30),
    )
    .is_some_and(|o| o.contains("[restart]"));
    doc.insert("pending_reboot".into(), json!(pending));
}

pub fn hardware(doc: &mut Map<String, Value>) {
    let hw = first(&profiler("SPHardwareDataType"));
    doc.insert("manufacturer".into(), json!("Apple"));
    doc.insert(
        "model".into(),
        json!(hw.get("machine_name").or(hw.get("machine_model"))),
    );
    doc.insert("model_identifier".into(), json!(hw.get("machine_model")));
    doc.insert("serial".into(), json!(hw.get("serial_number")));
    doc.insert("uuid".into(), json!(hw.get("platform_UUID")));
    doc.insert(
        "chip".into(),
        json!(hw.get("chip_type").or(hw.get("cpu_type"))),
    );
    doc.insert(
        "bios".into(),
        json!({ "vendor": "Apple", "version": hw.get("boot_rom_version") }),
    );
    let power = profiler("SPPowerDataType");
    let battery = power
        .as_array()
        .and_then(|a| {
            a.iter()
                .find(|p| p.get("sppower_battery_health_info").is_some())
        })
        .cloned();
    doc.insert(
        "batteries".into(),
        json!(battery.map(|b| vec![json!({
            "cycles": b.pointer("/sppower_battery_health_info/sppower_battery_cycle_count"),
            "condition": b.pointer("/sppower_battery_health_info/sppower_battery_health"),
            "charge_pct": b.pointer("/sppower_battery_charge_info/sppower_battery_state_of_charge"),
        })]).unwrap_or_default()),
    );
    let displays: Vec<Value> = profiler("SPDisplaysDataType")
        .as_array()
        .map(|gpus| {
            gpus.iter()
                .map(|g| json!({ "name": g.get("sppci_model"), "cores": g.get("sppci_cores") }))
                .collect()
        })
        .unwrap_or_default();
    doc.insert("gpus".into(), Value::Array(displays));
}

pub fn storage(doc: &mut Map<String, Value>) {
    let disks: Vec<Value> = profiler("SPNVMeDataType")
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|ctrl| ctrl.get("_items").and_then(Value::as_array).cloned().unwrap_or_default())
        .map(|d| json!({ "model": d.get("device_model"), "serial": d.get("device_serial"), "size_bytes": d.get("size_in_bytes"), "media": "ssd", "health": d.get("smart_status") }))
        .collect();
    doc.insert("disks".into(), Value::Array(disks));
}

pub fn network(doc: &mut Map<String, Value>) {
    let gateway = trimmed(run("route", &["-n", "get", "default"], T)).and_then(|o| {
        o.lines()
            .find(|l| l.trim_start().starts_with("gateway:"))
            .map(|l| l.split(':').nth(1).unwrap_or("").trim().to_string())
    });
    doc.insert(
        "gateways".into(),
        json!(gateway.map(|g| vec![g]).unwrap_or_default()),
    );
    let wifi = trimmed(run_any("ipconfig", &["getsummary", "en0"], T)).and_then(|o| {
        o.lines()
            .find(|l| l.trim_start().starts_with("SSID :"))
            .map(|l| l.split(':').nth(1).unwrap_or("").trim().to_string())
    });
    doc.insert(
        "wifi".into(),
        json!(wifi.map(|ssid| json!({ "ssid": ssid }))),
    );
}

pub fn software(doc: &mut Map<String, Value>) {
    let items: Vec<Value> = profiler("SPApplicationsDataType")
        .as_array()
        .map(|apps| {
            apps.iter()
                .filter(|a| a.get("path").and_then(Value::as_str).is_some_and(|p| p.starts_with("/Applications")))
                .map(|a| json!({ "name": a.get("_name"), "version": a.get("version").cloned().unwrap_or(json!("")), "publisher": a.get("obtained_from"), "install_date": a.get("lastModified"), "source": "app" }))
                .collect()
        })
        .unwrap_or_default();
    doc.insert("items".into(), Value::Array(items));
}

pub fn security(doc: &mut Map<String, Value>) {
    let filevault =
        trimmed(run_any("fdesetup", &["status"], T)).map(|s| s.contains("FileVault is On"));
    doc.insert(
        "encryption".into(),
        json!({ "method": "filevault", "system_volume_encrypted": filevault }),
    );
    let firewall = trimmed(run_any(
        "/usr/libexec/ApplicationFirewall/socketfilterfw",
        &["--getglobalstate"],
        T,
    ))
    .map(|s| s.contains("enabled"));
    doc.insert("firewall".into(), json!({ "enabled": firewall }));
    doc.insert(
        "gatekeeper".into(),
        json!(trimmed(run_any("spctl", &["--status"], T)).map(|s| s.contains("enabled"))),
    );
    doc.insert(
        "sip".into(),
        json!(trimmed(run_any("csrutil", &["status"], T)).map(|s| s.contains("enabled"))),
    );
    doc.insert("antivirus".into(), json!([{ "name": "XProtect", "enabled": true, "up_to_date": Value::Null, "source": "builtin" }]));
    doc.insert("local_admins".into(), json!(admins()));
    doc.insert("tcc".into(), tcc());
}

/// Screen Recording and Accessibility grants for the agent in the system TCC database
/// (`null` when the database cannot be read, e.g. without Full Disk Access).
pub fn tcc() -> Value {
    let exe = std::env::current_exe()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    if exe.contains('\'') {
        return json!({ "screen_recording": Value::Null, "accessibility": Value::Null });
    }
    let query = format!(
        "SELECT service, auth_value FROM access WHERE client = '{exe}' OR client = '{}'",
        crate::paths::LAUNCHD_LABEL
    );
    let out = run_any(
        "/usr/bin/sqlite3",
        &["/Library/Application Support/com.apple.TCC/TCC.db", &query],
        T,
    );
    let granted = |service: &str| -> Value {
        match &out {
            None => Value::Null,
            Some(text) => json!(text.lines().any(|l| {
                let mut parts = l.split('|');
                parts.next() == Some(service) && parts.next().map(str::trim) == Some("2")
            })),
        }
    };
    json!({
        "screen_recording": granted("kTCCServiceScreenCapture"),
        "accessibility": granted("kTCCServiceAccessibility"),
    })
}

fn admins() -> Vec<String> {
    trimmed(run_any(
        "dscl",
        &[".", "-read", "/Groups/admin", "GroupMembership"],
        T,
    ))
    .map(|o| o.split_whitespace().skip(1).map(str::to_string).collect())
    .unwrap_or_default()
}

pub fn users(doc: &mut Map<String, Value>) {
    let admins = admins();
    let local: Vec<Value> = trimmed(run("dscl", &[".", "-list", "/Users", "UniqueID"], T))
        .unwrap_or_default()
        .lines()
        .filter_map(|l| {
            let mut f = l.split_whitespace();
            let name = f.next()?;
            let uid: i64 = f.next()?.parse().ok()?;
            (uid >= 500 && !name.starts_with('_')).then(|| json!({ "name": name, "uid": uid, "admin": admins.iter().any(|a| a == name), "enabled": true }))
        })
        .collect();
    doc.insert("local".into(), Value::Array(local));
    let user = console_user();
    doc.insert(
        "last_user".into(),
        opt_str(user.clone().unwrap_or_default()),
    );
    doc.insert(
        "sessions".into(),
        json!(
            user.map(|u| vec![json!({ "user": u, "kind": "console" })])
                .unwrap_or_default()
        ),
    );
}

pub fn services(doc: &mut Map<String, Value>) {
    let items: Vec<Value> = run("launchctl", &["list"], T)
        .unwrap_or_default()
        .lines()
        .skip(1)
        .filter_map(|l| {
            let f: Vec<&str> = l.split('\t').collect();
            (f.len() == 3).then(|| json!({ "name": f[2], "state": if f[0] == "-" { "stopped" } else { "running" }, "last_exit": f[1] }))
        })
        .collect();
    doc.insert("items".into(), Value::Array(items));
}

pub fn updates(doc: &mut Map<String, Value>) {
    let out = run_any(
        "softwareupdate",
        &["--list", "--no-scan"],
        Duration::from_secs(30),
    )
    .unwrap_or_default();
    let pending: Vec<Value> = out
        .lines()
        .filter_map(|l| {
            l.trim()
                .strip_prefix("* Label:")
                .map(|s| json!({ "label": s.trim() }))
        })
        .collect();
    doc.insert("pending".into(), Value::Array(pending));
}
