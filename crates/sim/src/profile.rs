//! Deterministic, realistic device profiles (seeded per index, so restarts look the same).

use rustrmm_proto::messages::{Heartbeat, MetricSample};
use serde_json::{Value, json};

/// SplitMix64 — tiny deterministic PRNG.
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Self(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ 0xD1B5_4A32_D192_ED03)
    }

    pub fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    pub fn range(&mut self, lo: u64, hi: u64) -> u64 {
        lo + self.next() % (hi - lo + 1)
    }

    pub fn f(&mut self) -> f64 {
        (self.next() >> 11) as f64 / (1u64 << 53) as f64
    }

    pub fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        &items[(self.next() % items.len() as u64) as usize]
    }

    pub fn chance(&mut self, p: f64) -> bool {
        self.f() < p
    }
}

pub struct Profile {
    pub index: usize,
    pub hostname: String,
    pub os_family: &'static str,
    pub os_name: String,
    pub os_version: String,
    pub arch: &'static str,
    pub device_type: &'static str,
    pub manufacturer: String,
    pub model: String,
    pub serial: String,
    pub uuid: String,
    pub domain: Option<String>,
    pub cpu: String,
    pub cores: u64,
    pub ram_gb: u64,
    pub disk_gb: u64,
    pub disk_used_pct: f64,
    pub user: Option<String>,
    pub av_enabled: bool,
    pub firewall: bool,
    pub encrypted: bool,
    pub pending_reboot: bool,
    pub base_cpu: f64,
    pub base_mem: f64,
}

const FIRST: &[&str] = &[
    "alex", "jordan", "sam", "taylor", "morgan", "casey", "riley", "jamie", "avery", "quinn",
    "drew", "parker", "reese", "skyler", "rowan", "emery",
];
const LAST: &[&str] = &[
    "nguyen", "patel", "garcia", "kim", "oconnor", "schmidt", "rossi", "haddad", "silva", "novak",
    "tanaka", "brooks", "ramirez", "olsen", "mehta", "ward",
];

impl Profile {
    pub fn generate(index: usize) -> Self {
        let mut r = Rng::new(index as u64 + 1);
        let roll = r.f();
        let user = format!("{}.{}", r.pick(FIRST), r.pick(LAST));
        let n = index + 1;
        let (os_family, os_name, os_version, device_type, hostname, manufacturer, model) =
            if roll < 0.5 {
                let win11 = r.chance(0.75);
                let laptop = r.chance(0.55);
                let (mfr, model) = if laptop {
                    r.pick(&[
                        ("Dell Inc.", "Latitude 7450"),
                        ("HP", "EliteBook 840 G11"),
                        ("LENOVO", "ThinkPad T14 Gen 5"),
                        ("Microsoft Corporation", "Surface Laptop 7"),
                    ])
                    .to_owned()
                } else {
                    r.pick(&[
                        ("Dell Inc.", "OptiPlex 7020"),
                        ("HP", "ProDesk 400 G9"),
                        ("LENOVO", "ThinkCentre M90q Gen 5"),
                    ])
                    .to_owned()
                };
                (
                    "windows",
                    if win11 {
                        "Windows 11 Pro".to_string()
                    } else {
                        "Windows 10 Pro".to_string()
                    },
                    if win11 {
                        "10.0.26100".to_string()
                    } else {
                        "10.0.19045".to_string()
                    },
                    if laptop { "laptop" } else { "workstation" },
                    format!(
                        "{}-{}{:03}",
                        if laptop { "LT" } else { "WS" },
                        ["ACME", "NWD", "HPL", "SMF"][index % 4],
                        n
                    ),
                    mfr.to_string(),
                    model.to_string(),
                )
            } else if roll < 0.68 {
                let virt = r.chance(0.6);
                let role = r.pick(&["DC", "FILE", "APP", "SQL", "PRINT", "RDS"]);
                (
                    "windows",
                    if r.chance(0.5) {
                        "Windows Server 2025 Standard".to_string()
                    } else {
                        "Windows Server 2022 Standard".to_string()
                    },
                    "10.0.20348".to_string(),
                    if virt { "virtual" } else { "server" },
                    format!("SRV-{role}{:02}", n % 20 + 1),
                    if virt {
                        "Microsoft Corporation".to_string()
                    } else {
                        "Dell Inc.".to_string()
                    },
                    if virt {
                        "Virtual Machine".to_string()
                    } else {
                        "PowerEdge R660".to_string()
                    },
                )
            } else if roll < 0.84 {
                let distro = r
                    .pick(&[
                        ("Ubuntu 24.04.1 LTS", "24.04"),
                        ("Red Hat Enterprise Linux 9.5", "9.5"),
                        ("Debian GNU/Linux 12 (bookworm)", "12"),
                    ])
                    .to_owned();
                (
                    "linux",
                    distro.0.to_string(),
                    distro.1.to_string(),
                    if r.chance(0.7) { "virtual" } else { "server" },
                    format!(
                        "{}-{:02}",
                        r.pick(&["web", "db", "app", "proxy", "backup", "monitor"]),
                        n % 30 + 1
                    ),
                    "QEMU".to_string(),
                    "Standard PC (Q35 + ICH9, 2009)".to_string(),
                )
            } else {
                let model = *r.pick(&[
                    "MacBook Pro (14-inch, 2024)",
                    "MacBook Air (13-inch, M3, 2024)",
                    "Mac mini (2024)",
                    "iMac (24-inch, 2024)",
                ]);
                (
                    "macos",
                    if r.chance(0.6) {
                        "macOS 26".to_string()
                    } else {
                        "macOS 15.6".to_string()
                    },
                    if r.chance(0.6) {
                        "26.1".to_string()
                    } else {
                        "15.6".to_string()
                    },
                    if model.contains("Book") {
                        "laptop"
                    } else {
                        "workstation"
                    },
                    format!(
                        "MAC-{}",
                        user.split('.').next().unwrap_or("user").to_uppercase()
                    ),
                    "Apple".to_string(),
                    model.to_string(),
                )
            };
        let server = matches!(device_type, "server" | "virtual");
        let cores = if server {
            *r.pick(&[4, 8, 16])
        } else {
            *r.pick(&[6, 8, 10, 12])
        };
        let disk_gb = *r.pick(&[256, 512, 1024]);
        Self {
            index,
            hostname,
            os_family,
            os_name,
            os_version,
            arch: if os_family == "macos" {
                "aarch64"
            } else {
                "x86_64"
            },
            device_type,
            manufacturer,
            model,
            serial: format!("{:X}{:06X}", r.range(0x10, 0xFF), r.next() & 0xFF_FFFF),
            uuid: format!(
                "{:08X}-{:04X}-{:04X}-{:04X}-{:012X}",
                r.next() as u32,
                r.next() as u16,
                r.next() as u16,
                r.next() as u16,
                r.next() & 0xFFFF_FFFF_FFFF
            ),
            domain: (os_family == "windows" && r.chance(0.8))
                .then(|| "corp.acme-dental.test".to_string()),
            cpu: match os_family {
                "macos" => "Apple M3 Pro".to_string(),
                _ if server => "Intel(R) Xeon(R) Silver 4410Y".to_string(),
                _ => r
                    .pick(&[
                        "Intel(R) Core(TM) Ultra 7 155U",
                        "AMD Ryzen 7 PRO 8840U",
                        "Intel(R) Core(TM) i5-14500",
                    ])
                    .to_string(),
            },
            cores,
            ram_gb: if server {
                *r.pick(&[16, 32, 64])
            } else {
                *r.pick(&[16, 16, 32])
            },
            disk_gb,
            disk_used_pct: if r.chance(0.12) {
                91.0 + r.f() * 7.0
            } else {
                25.0 + r.f() * 50.0
            },
            user: (!server).then_some(user),
            av_enabled: !r.chance(0.08),
            firewall: !r.chance(0.1),
            encrypted: if device_type == "laptop" {
                !r.chance(0.15)
            } else {
                r.chance(0.5)
            },
            pending_reboot: r.chance(0.2),
            base_cpu: if r.chance(0.1) {
                70.0
            } else {
                5.0 + r.f() * 25.0
            },
            base_mem: 35.0 + r.f() * 40.0,
        }
    }

    pub fn inventory(&self) -> Vec<(String, Value)> {
        let mut r = Rng::new(self.index as u64 * 7919 + 13);
        let software = self.software(&mut r);
        vec![
            (
                "system".into(),
                json!({
                    "hostname": self.hostname,
                    "os": { "family": self.os_family, "name": self.os_name, "version": self.os_version, "kernel": self.os_version },
                    "arch": self.arch,
                    "device_type": self.device_type,
                    "domain": self.domain,
                    "pending_reboot": self.pending_reboot,
                    "pending_reboot_reasons": if self.pending_reboot { vec!["windows_update"] } else { vec![] },
                    "agent_version": env!("CARGO_PKG_VERSION"),
                }),
            ),
            (
                "hardware".into(),
                json!({
                    "manufacturer": self.manufacturer,
                    "model": self.model,
                    "serial": self.serial,
                    "uuid": self.uuid,
                    "bios": { "vendor": self.manufacturer, "version": format!("1.{}.{}", r.range(1, 30), r.range(0, 9)) },
                    "cpu": { "model": self.cpu, "cores": self.cores, "threads": self.cores * 2, "mhz": 2400 },
                    "memory": { "total_bytes": self.ram_gb * 1_073_741_824 },
                    "gpus": [{ "name": if self.os_family == "macos" { "Apple M3 Pro GPU" } else { "Intel(R) Graphics" } }],
                    "secure_boot": self.os_family != "linux",
                    "tpm": { "present": self.os_family == "windows", "spec_version": "2.0" },
                    "batteries": if self.device_type == "laptop" { vec![json!({ "charge_pct": r.range(20, 100), "cycles": r.range(30, 600) })] } else { vec![] },
                }),
            ),
            (
                "storage".into(),
                json!({
                    "volumes": [{
                        "mount": if self.os_family == "windows" { "C:\\" } else { "/" },
                        "name": "System",
                        "filesystem": match self.os_family { "windows" => "NTFS", "macos" => "APFS", _ => "ext4" },
                        "total_bytes": self.disk_gb * 1_000_000_000,
                        "free_bytes": ((100.0 - self.disk_used_pct) / 100.0 * self.disk_gb as f64 * 1e9) as u64,
                        "kind": "ssd", "removable": false, "read_only": false
                    }],
                    "disks": [{ "model": "NVMe SSD", "size_bytes": self.disk_gb * 1_000_000_000, "media": "ssd", "health": "OK" }],
                }),
            ),
            (
                "network".into(),
                json!({
                    "interfaces": [{ "name": if self.os_family == "windows" { "Ethernet" } else { "eth0" }, "mac": format!("00:1A:2B:{:02X}:{:02X}:{:02X}", r.range(0, 255), r.range(0, 255), r.range(0, 255)),
                                     "ipv4": [format!("10.20.{}.{}/24", self.index / 200, self.index % 200 + 20)], "ipv6": [], "mtu": 1500, "speed_mbps": 1000 }],
                    "gateways": ["10.20.0.1"],
                    "dns_servers": ["10.20.0.10", "10.20.0.11"],
                }),
            ),
            ("software".into(), json!({ "items": software })),
            ("security".into(), {
                let mut sec = json!({
                    "firewall": { "enabled": self.firewall },
                    "encryption": { "method": match self.os_family { "windows" => "bitlocker", "macos" => "filevault", _ => "luks" }, "system_volume_encrypted": self.encrypted },
                    "local_admins": ["Administrator", "corp\\Domain Admins"],
                });
                if self.os_family == "windows" {
                    sec["antivirus"] = json!([{ "name": "Microsoft Defender Antivirus", "enabled": self.av_enabled, "up_to_date": true, "source": "defender" }]);
                    sec["uac_enabled"] = json!(true);
                    sec["rdp_enabled"] =
                        json!(self.device_type == "server" || self.device_type == "virtual");
                } else if self.os_family == "macos" {
                    sec["antivirus"] =
                        json!([{ "name": "XProtect", "enabled": true, "source": "builtin" }]);
                    sec["sip"] = json!(true);
                    sec["gatekeeper"] = json!(true);
                }
                sec
            }),
            (
                "users".into(),
                json!({
                    "local": [{ "name": "Administrator", "enabled": false, "admin": true }, { "name": self.user.clone().unwrap_or_else(|| "svc-backup".into()), "enabled": true, "admin": false }],
                    "last_user": self.user,
                    "sessions": self.user.iter().map(|u| json!({ "user": u, "kind": "console" })).collect::<Vec<_>>(),
                }),
            ),
            (
                "services".into(),
                json!({ "items": [
                { "name": "RustRMMAgent", "display_name": "RustRMM Agent", "state": "running", "start_mode": "auto" },
                { "name": "Spooler", "display_name": "Print Spooler", "state": "running", "start_mode": "auto" },
                { "name": "W32Time", "display_name": "Windows Time", "state": "running", "start_mode": "manual" },
            ] }),
            ),
            (
                "updates".into(),
                json!({ "pending_reboot": self.pending_reboot, "installed": [{ "id": "KB5044284", "description": "Security Update" }] }),
            ),
        ]
    }

    fn software(&self, r: &mut Rng) -> Vec<Value> {
        let catalog: &[(&str, &str, &str)] = match self.os_family {
            "windows" => &[
                ("Google Chrome", "131.0.6778.86", "Google LLC"),
                ("Microsoft Edge", "131.0.2903.70", "Microsoft Corporation"),
                (
                    "Microsoft 365 Apps for business - en-us",
                    "16.0.18129.20158",
                    "Microsoft Corporation",
                ),
                (
                    "Microsoft Teams",
                    "24295.605.3225.8804",
                    "Microsoft Corporation",
                ),
                ("Zoom Workplace", "6.2.11", "Zoom Communications, Inc."),
                ("7-Zip 24.08 (x64)", "24.08", "Igor Pavlov"),
                ("Adobe Acrobat Reader (64-bit)", "24.004.20220", "Adobe"),
                ("Mozilla Firefox (x64 en-US)", "133.0", "Mozilla"),
                ("Notepad++ (64-bit x64)", "8.7.1", "Notepad++ Team"),
                ("VLC media player", "3.0.21", "VideoLAN"),
                ("Dentrix G7", "7.4.2", "Henry Schein One"),
                (
                    "Microsoft Visual C++ 2015-2022 Redistributable (x64)",
                    "14.40.33816.0",
                    "Microsoft Corporation",
                ),
            ],
            "macos" => &[
                ("Google Chrome", "131.0.6778.86", "Google"),
                ("Slack", "4.41.105", "Slack Technologies"),
                ("zoom.us", "6.2.11", "Zoom"),
                ("Microsoft Word", "16.91", "Microsoft"),
                ("1Password", "8.10.54", "AgileBits"),
                ("Visual Studio Code", "1.95.3", "Microsoft"),
            ],
            _ => &[
                ("openssh-server", "1:9.6p1-3ubuntu13.5", "Ubuntu Developers"),
                ("nginx", "1.24.0-2ubuntu7.1", "Ubuntu Developers"),
                (
                    "postgresql-16",
                    "16.4-0ubuntu0.24.04.2",
                    "Ubuntu Developers",
                ),
                ("docker-ce", "5:27.3.1-1~ubuntu.24.04~noble", "Docker Inc."),
                ("curl", "8.5.0-2ubuntu10.5", "Ubuntu Developers"),
                ("python3", "3.12.3-0ubuntu2", "Ubuntu Developers"),
            ],
        };
        catalog
            .iter()
            .filter(|_| r.chance(0.85))
            .map(|(name, version, publisher)| json!({ "name": name, "version": version, "publisher": publisher, "source": "simulated" }))
            .collect()
    }
}

/// Random-walk metrics per device.
pub struct LiveState {
    cpu: f64,
    mem: f64,
    disk: f64,
    rng: Rng,
}

impl LiveState {
    pub fn new(profile: &Profile) -> Self {
        Self {
            cpu: profile.base_cpu,
            mem: profile.base_mem,
            disk: profile.disk_used_pct,
            rng: Rng::new(profile.index as u64 ^ 0xABCD),
        }
    }

    pub fn sample(&mut self) -> MetricSample {
        let drift = |v: f64, r: &mut Rng, span: f64, lo: f64, hi: f64| {
            (v + (r.f() - 0.5) * span).clamp(lo, hi)
        };
        self.cpu = drift(self.cpu, &mut self.rng, 12.0, 1.0, 99.0);
        self.mem = drift(self.mem, &mut self.rng, 3.0, 10.0, 97.0);
        self.disk = drift(self.disk, &mut self.rng, 0.05, 5.0, 99.5);
        MetricSample {
            ts: chrono::Utc::now().timestamp(),
            cpu: self.cpu as f32,
            mem: self.mem as f32,
            disk: self.disk as f32,
            net_rx_bps: self.rng.f() * 40_000_000.0,
            net_tx_bps: self.rng.f() * 8_000_000.0,
            disk_read_bps: self.rng.f() * 30_000_000.0,
            disk_write_bps: self.rng.f() * 12_000_000.0,
            process_count: 180 + (self.rng.next() % 80) as u32,
        }
    }

    pub fn heartbeat(&mut self, profile: &Profile) -> Heartbeat {
        let s = self.sample();
        Heartbeat {
            uptime_s: 3600 * (24 + profile.index as u64 * 7),
            cpu_pct: s.cpu,
            mem_pct: s.mem,
            disk_pct: s.disk,
            logged_in_user: profile.user.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profiles_are_deterministic_and_varied() {
        let a = Profile::generate(3);
        let b = Profile::generate(3);
        assert_eq!(a.hostname, b.hostname);
        assert_eq!(a.uuid, b.uuid);
        let families: std::collections::BTreeSet<_> =
            (0..60).map(|i| Profile::generate(i).os_family).collect();
        assert_eq!(families.len(), 3, "windows, linux and macos all appear");
        let hosts: std::collections::BTreeSet<_> =
            (0..60).map(|i| Profile::generate(i).uuid).collect();
        assert_eq!(hosts.len(), 60, "hardware identities are unique");
    }
}
