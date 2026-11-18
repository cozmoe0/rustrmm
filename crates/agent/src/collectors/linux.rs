//! Linux inventory from /sys, /proc, /etc and standard tools.

use std::collections::BTreeSet;
use std::time::Duration;

use serde_json::{Map, Value, json};

use super::opt_str;
use crate::util::{run, run_any};

const T: Duration = Duration::from_secs(20);

fn read(path: &str) -> Option<String> {
    std::fs::read_to_string(path)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn dmi(name: &str) -> Option<String> {
    read(&format!("/sys/class/dmi/id/{name}"))
        .filter(|v| !v.eq_ignore_ascii_case("to be filled by o.e.m."))
}

fn os_release() -> std::collections::HashMap<String, String> {
    read("/etc/os-release")
        .unwrap_or_default()
        .lines()
        .filter_map(|l| l.split_once('='))
        .map(|(k, v)| (k.to_string(), v.trim_matches('"').to_string()))
        .collect()
}

fn have(program: &str) -> bool {
    std::env::var_os("PATH")
        .map(|paths| std::env::split_paths(&paths).any(|p| p.join(program).is_file()))
        .unwrap_or(false)
}

pub fn identity() -> (Option<String>, Option<String>, Option<String>) {
    let domain = run("hostname", &["-d"], T)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty() && s != "(none)");
    (dmi("product_uuid"), dmi("product_serial"), domain)
}

pub fn console_user() -> Option<String> {
    let out = run_any("who", &[], T)?;
    out.lines()
        .find(|l| l.contains(" tty") || l.contains(":0") || l.contains("seat"))
        .or_else(|| out.lines().next())
        .and_then(|l| l.split_whitespace().next())
        .map(str::to_string)
}

pub fn system(doc: &mut Map<String, Value>) {
    let rel = os_release();
    if let Some(Value::Object(os)) = doc.get_mut("os") {
        if let Some(name) = rel.get("PRETTY_NAME") {
            os.insert("name".into(), json!(name));
        }
        if let Some(version) = rel.get("VERSION_ID") {
            os.insert("version".into(), json!(version));
        }
        os.insert(
            "id".into(),
            opt_str(rel.get("ID").cloned().unwrap_or_default()),
        );
    }
    let virt = run_any("systemd-detect-virt", &[], T)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty() && s != "none");
    let chassis: u32 = dmi("chassis_type")
        .and_then(|c| c.parse().ok())
        .unwrap_or(0);
    let device_type = if virt.is_some() {
        "virtual"
    } else if matches!(chassis, 8..=10 | 14 | 30..=32) {
        "laptop"
    } else if matches!(chassis, 17 | 23 | 28 | 29)
        || rel.get("ID").is_some_and(|id| id.contains("server"))
        || console_user().is_none()
    {
        "server"
    } else {
        "workstation"
    };
    doc.insert("device_type".into(), json!(device_type));
    doc.insert("virtualization".into(), json!(virt));
    doc.insert("domain".into(), json!(identity().2));
    let mut reasons = Vec::new();
    if std::path::Path::new("/var/run/reboot-required").exists() {
        reasons.push("packages");
    }
    if have("needs-restarting") && run("needs-restarting", &["-r"], T).is_none() {
        reasons.push("needs_restarting");
    }
    doc.insert("pending_reboot".into(), json!(!reasons.is_empty()));
    doc.insert("pending_reboot_reasons".into(), json!(reasons));
}

pub fn hardware(doc: &mut Map<String, Value>) {
    doc.insert("manufacturer".into(), json!(dmi("sys_vendor")));
    doc.insert("model".into(), json!(dmi("product_name")));
    doc.insert("serial".into(), json!(dmi("product_serial")));
    doc.insert("uuid".into(), json!(dmi("product_uuid")));
    doc.insert("bios".into(), json!({ "vendor": dmi("bios_vendor"), "version": dmi("bios_version"), "date": dmi("bios_date") }));
    doc.insert(
        "baseboard".into(),
        json!({ "manufacturer": dmi("board_vendor"), "product": dmi("board_name") }),
    );
    doc.insert(
        "chassis_types".into(),
        json!(
            dmi("chassis_type")
                .and_then(|c| c.parse::<u32>().ok())
                .map(|c| vec![c])
        ),
    );
    doc.insert(
        "secure_boot".into(),
        json!(run_any("mokutil", &["--sb-state"], T).map(|s| s.contains("enabled"))),
    );
    doc.insert(
        "tpm".into(),
        json!({ "present": std::path::Path::new("/sys/class/tpm/tpm0").exists() }),
    );
    let gpus: Vec<Value> = run_any("lspci", &["-mm"], T)
        .unwrap_or_default()
        .lines()
        .filter(|l| l.contains("VGA") || l.contains("3D controller"))
        .map(|l| json!({ "name": l.split('"').filter(|p| !p.trim().is_empty()).nth(2).unwrap_or(l).trim() }))
        .collect();
    doc.insert("gpus".into(), Value::Array(gpus));
    let batteries: Vec<Value> = std::fs::read_dir("/sys/class/power_supply")
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| read(&format!("{}/type", e.path().display())).as_deref() == Some("Battery"))
        .map(|e| {
            let p = e.path().display().to_string();
            json!({ "name": e.file_name().to_string_lossy(), "charge_pct": read(&format!("{p}/capacity")), "status": read(&format!("{p}/status")),
                    "design_capacity": read(&format!("{p}/energy_full_design")), "full_charge_capacity": read(&format!("{p}/energy_full")), "cycles": read(&format!("{p}/cycle_count")) })
        })
        .collect();
    doc.insert("batteries".into(), Value::Array(batteries));
}

pub fn storage(doc: &mut Map<String, Value>) {
    if let Some(out) = run(
        "lsblk",
        &[
            "-J",
            "-b",
            "-o",
            "NAME,TYPE,SIZE,MODEL,SERIAL,ROTA,TRAN,FSTYPE,MOUNTPOINT",
        ],
        T,
    ) && let Ok(value) = serde_json::from_str::<Value>(&out)
    {
        let devices = value
            .get("blockdevices")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let disks: Vec<Value> = devices
            .iter()
            .filter(|d| d.get("type").and_then(Value::as_str) == Some("disk"))
            .map(|d| json!({
                "name": d.get("name"), "model": d.get("model"), "serial": d.get("serial"), "size_bytes": d.get("size"),
                "media": if d.get("rota").and_then(Value::as_bool).unwrap_or(false) { "hdd" } else { "ssd" }, "bus": d.get("tran"),
            }))
            .collect();
        doc.insert("disks".into(), Value::Array(disks));
        doc.insert(
            "system_volume_encrypted".into(),
            json!(root_on_crypt(&devices, false)),
        );
    }
}

/// True when `/` lives on a dm-crypt (LUKS) device.
fn root_on_crypt(devices: &[Value], inside_crypt: bool) -> bool {
    devices.iter().any(|d| {
        let crypt = inside_crypt || d.get("type").and_then(Value::as_str) == Some("crypt");
        if crypt && d.get("mountpoint").and_then(Value::as_str) == Some("/") {
            return true;
        }
        d.get("children")
            .and_then(Value::as_array)
            .is_some_and(|c| root_on_crypt(c, crypt))
    })
}

pub fn network(doc: &mut Map<String, Value>) {
    if let Some(out) = run("ip", &["-j", "route", "show", "default"], T)
        && let Ok(Value::Array(routes)) = serde_json::from_str::<Value>(&out)
    {
        let gateways: Vec<Value> = routes
            .iter()
            .filter_map(|r| r.get("gateway").cloned())
            .collect();
        doc.insert("gateways".into(), Value::Array(gateways));
    }
    let dns: Vec<String> = read("/etc/resolv.conf")
        .unwrap_or_default()
        .lines()
        .filter_map(|l| l.strip_prefix("nameserver"))
        .map(|s| s.trim().to_string())
        .collect();
    doc.insert("dns_servers".into(), json!(dns));
}

pub fn software(doc: &mut Map<String, Value>) {
    let mut items = Vec::new();
    if have("dpkg-query") {
        for line in run(
            "dpkg-query",
            &[
                "-W",
                "-f",
                "${Package}\t${Version}\t${Maintainer}\t${db:Status-Abbrev}\n",
            ],
            T,
        )
        .unwrap_or_default()
        .lines()
        {
            let f: Vec<&str> = line.split('\t').collect();
            if f.len() >= 4 && f[3].starts_with("ii") {
                items.push(
                    json!({ "name": f[0], "version": f[1], "publisher": f[2], "source": "dpkg" }),
                );
            }
        }
    } else if have("rpm") {
        for line in run(
            "rpm",
            &[
                "-qa",
                "--queryformat",
                "%{NAME}\t%{VERSION}-%{RELEASE}\t%{VENDOR}\t%{INSTALLTIME}\n",
            ],
            T,
        )
        .unwrap_or_default()
        .lines()
        {
            let f: Vec<&str> = line.split('\t').collect();
            if f.len() >= 4 {
                let date = f[3]
                    .parse::<i64>()
                    .ok()
                    .and_then(|t| chrono::DateTime::<chrono::Utc>::from_timestamp(t, 0))
                    .map(|d| d.format("%Y-%m-%d").to_string());
                items.push(json!({ "name": f[0], "version": f[1], "publisher": f[2], "install_date": date, "source": "rpm" }));
            }
        }
    } else if have("pacman") {
        for line in run("pacman", &["-Q"], T).unwrap_or_default().lines() {
            if let Some((name, version)) = line.split_once(' ') {
                items.push(json!({ "name": name, "version": version, "source": "pacman" }));
            }
        }
    } else if have("apk") {
        for line in run("apk", &["info", "-v"], T).unwrap_or_default().lines() {
            if let Some(idx) = line.rmatch_indices('-').nth(1).map(|(i, _)| i) {
                items.push(
                    json!({ "name": &line[..idx], "version": &line[idx + 1..], "source": "apk" }),
                );
            }
        }
    }
    if have("snap") {
        for line in run("snap", &["list"], T)
            .unwrap_or_default()
            .lines()
            .skip(1)
        {
            let f: Vec<&str> = line.split_whitespace().collect();
            if f.len() >= 2 {
                items.push(json!({ "name": f[0], "version": f[1], "publisher": f.get(4), "source": "snap" }));
            }
        }
    }
    if have("flatpak") {
        for line in run(
            "flatpak",
            &["list", "--app", "--columns=application,version,origin"],
            T,
        )
        .unwrap_or_default()
        .lines()
        {
            let f: Vec<&str> = line.split('\t').collect();
            if !f.is_empty() {
                items.push(json!({ "name": f[0], "version": f.get(1).unwrap_or(&""), "publisher": f.get(2), "source": "flatpak" }));
            }
        }
    }
    doc.insert("items".into(), Value::Array(items));
}

fn admin_members() -> BTreeSet<String> {
    let mut admins = BTreeSet::from(["root".to_string()]);
    for line in read("/etc/group").unwrap_or_default().lines() {
        let f: Vec<&str> = line.split(':').collect();
        if f.len() >= 4 && matches!(f[0], "sudo" | "wheel" | "admin") {
            admins.extend(
                f[3].split(',')
                    .filter(|s| !s.is_empty())
                    .map(str::to_string),
            );
        }
    }
    admins
}

pub fn security(doc: &mut Map<String, Value>) {
    let firewall = if have("ufw") {
        run("ufw", &["status"], T).map(|s| s.contains("Status: active"))
    } else if have("firewall-cmd") {
        Some(run("firewall-cmd", &["--state"], T).is_some_and(|s| s.trim() == "running"))
    } else if have("nft") {
        run("nft", &["list", "ruleset"], T).map(|s| s.lines().any(|l| l.contains("hook input")))
    } else {
        None
    };
    doc.insert("firewall".into(), json!({ "enabled": firewall }));
    let encrypted = run("lsblk", &["-J", "-o", "NAME,TYPE,MOUNTPOINT"], T)
        .and_then(|o| serde_json::from_str::<Value>(&o).ok())
        .map(|v| {
            root_on_crypt(
                v.get("blockdevices")
                    .and_then(Value::as_array)
                    .map(Vec::as_slice)
                    .unwrap_or(&[]),
                false,
            )
        });
    doc.insert(
        "encryption".into(),
        json!({ "method": "luks", "system_volume_encrypted": encrypted }),
    );
    doc.insert(
        "selinux".into(),
        json!(run_any("getenforce", &[], T).map(|s| s.trim().to_lowercase())),
    );
    doc.insert(
        "apparmor".into(),
        json!(read("/sys/module/apparmor/parameters/enabled").map(|s| s == "Y")),
    );
    doc.insert(
        "ssh_root_login".into(),
        json!(read("/etc/ssh/sshd_config").map(|c| {
            c.lines()
                .any(|l| l.trim().starts_with("PermitRootLogin yes"))
        })),
    );
    doc.insert("local_admins".into(), json!(admin_members()));
}

pub fn users(doc: &mut Map<String, Value>) {
    let admins = admin_members();
    let local: Vec<Value> = read("/etc/passwd")
        .unwrap_or_default()
        .lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split(':').collect();
            let uid: u32 = f.get(2)?.parse().ok()?;
            let shell = f.get(6).copied().unwrap_or("");
            (uid == 0 || (1000..60000).contains(&uid)).then(|| {
                json!({ "name": f[0], "full_name": f.get(4).map(|g| g.split(',').next().unwrap_or("")), "uid": uid,
                        "enabled": !shell.ends_with("nologin") && !shell.ends_with("false"), "admin": admins.contains(f[0]) })
            })
        })
        .collect();
    doc.insert("local".into(), Value::Array(local));
    let sessions: Vec<Value> = run_any("who", &[], T)
        .unwrap_or_default()
        .lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split_whitespace().collect();
            Some(json!({ "user": f.first()?, "kind": f.get(1), "from": l.split('(').nth(1).map(|s| s.trim_end_matches(')')) }))
        })
        .collect();
    doc.insert(
        "last_user".into(),
        json!(sessions.first().and_then(|s| s.get("user")).cloned()),
    );
    doc.insert("sessions".into(), Value::Array(sessions));
}

pub fn services(doc: &mut Map<String, Value>) {
    let items: Vec<Value> = run("systemctl", &["list-units", "--type=service", "--all", "--no-legend", "--plain", "--no-pager"], T)
        .unwrap_or_default()
        .lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split_whitespace().collect();
            if f.len() < 4 {
                return None;
            }
            Some(json!({ "name": f[0].trim_end_matches(".service"), "display_name": f[4..].join(" "), "state": f[3], "active": f[2], "load": f[1] }))
        })
        .collect();
    doc.insert("items".into(), Value::Array(items));
}

pub fn updates(doc: &mut Map<String, Value>) {
    doc.insert(
        "pending_reboot".into(),
        json!(std::path::Path::new("/var/run/reboot-required").exists()),
    );
    doc.insert(
        "package_manager".into(),
        json!(
            ["apt-get", "dnf", "yum", "zypper", "pacman", "apk"]
                .iter()
                .find(|p| have(p))
        ),
    );
}
