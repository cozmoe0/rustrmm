//! Windows inventory via WMI and the registry.

use std::collections::{BTreeSet, HashMap};
use std::time::Duration;

use serde_json::{Map, Value, json};
use winreg::RegKey;
use winreg::enums::{HKEY_LOCAL_MACHINE, HKEY_USERS, KEY_READ, KEY_WOW64_64KEY};
use wmi::{Variant, WMIConnection};

use super::opt_str;

/// Fixed MSI ProductCode (never changes, so GPO-assigned installs stay recognised).
pub const MSI_PRODUCT_CODE: &str = "{6F1C2B8E-8A43-4C37-9C1E-5B7A2E9D4F10}";

pub(crate) type Row = HashMap<String, Variant>;

pub(crate) fn query(namespace: &str, wql: &str) -> Vec<Row> {
    let conn = match WMIConnection::with_namespace_path(namespace) {
        Ok(c) => c,
        Err(e) => {
            tracing::debug!(namespace, error = %e, "WMI namespace unavailable");
            return Vec::new();
        }
    };
    match conn.raw_query::<Row>(wql) {
        Ok(rows) => rows,
        Err(e) => {
            tracing::debug!(wql, error = %e, "WMI query failed");
            Vec::new()
        }
    }
}

fn cimv2(wql: &str) -> Vec<Row> {
    query("ROOT\\CIMV2", wql)
}

pub(crate) fn val(row: &Row, key: &str) -> Value {
    row.get(key).map(variant_json).unwrap_or(Value::Null)
}

fn variant_json(v: &Variant) -> Value {
    match v {
        Variant::Empty | Variant::Null => Value::Null,
        Variant::String(s) => opt_str(s),
        Variant::I1(n) => json!(n),
        Variant::I2(n) => json!(n),
        Variant::I4(n) => json!(n),
        Variant::I8(n) => json!(n),
        Variant::R4(n) => json!(n),
        Variant::R8(n) => json!(n),
        Variant::Bool(b) => json!(b),
        Variant::UI1(n) => json!(n),
        Variant::UI2(n) => json!(n),
        Variant::UI4(n) => json!(n),
        Variant::UI8(n) => json!(n),
        Variant::Array(items) => Value::Array(items.iter().map(variant_json).collect()),
        _ => Value::Null,
    }
}

pub(crate) fn s(row: &Row, key: &str) -> Option<String> {
    match row.get(key) {
        Some(Variant::String(s)) if !s.trim().is_empty() => Some(s.trim().to_string()),
        _ => None,
    }
}

pub(crate) fn u(row: &Row, key: &str) -> Option<u64> {
    match row.get(key)? {
        Variant::UI1(n) => Some(u64::from(*n)),
        Variant::UI2(n) => Some(u64::from(*n)),
        Variant::UI4(n) => Some(u64::from(*n)),
        Variant::UI8(n) => Some(*n),
        Variant::I2(n) => u64::try_from(*n).ok(),
        Variant::I4(n) => u64::try_from(*n).ok(),
        Variant::I8(n) => u64::try_from(*n).ok(),
        Variant::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

pub(crate) fn b(row: &Row, key: &str) -> Option<bool> {
    match row.get(key)? {
        Variant::Bool(v) => Some(*v),
        other => u(&HashMap::from([(key.to_string(), other.clone())]), key).map(|n| n != 0),
    }
}

/// WMI datetime `yyyymmddHHMMSS.ffffff±UUU` → RFC 3339 (UTC offset applied).
pub(crate) fn wmi_date(raw: &str) -> Option<String> {
    if raw.len() < 14 {
        return None;
    }
    let base = chrono::NaiveDateTime::parse_from_str(&raw[..14], "%Y%m%d%H%M%S").ok()?;
    let offset_min: i64 = raw.get(21..).and_then(|o| o.parse().ok()).unwrap_or(0);
    let utc = base - chrono::Duration::minutes(offset_min);
    Some(chrono::DateTime::<chrono::Utc>::from_naive_utc_and_offset(utc, chrono::Utc).to_rfc3339())
}

fn date(row: &Row, key: &str) -> Value {
    s(row, key)
        .and_then(|d| wmi_date(&d))
        .map(Value::String)
        .unwrap_or(Value::Null)
}

fn hklm() -> RegKey {
    RegKey::predef(HKEY_LOCAL_MACHINE)
}

pub(crate) fn reg_dword(path: &str, name: &str) -> Option<u32> {
    hklm()
        .open_subkey_with_flags(path, KEY_READ | KEY_WOW64_64KEY)
        .ok()?
        .get_value::<u32, _>(name)
        .ok()
}

fn reg_string(path: &str, name: &str) -> Option<String> {
    hklm()
        .open_subkey_with_flags(path, KEY_READ | KEY_WOW64_64KEY)
        .ok()?
        .get_value::<String, _>(name)
        .ok()
}

fn reg_key_exists(path: &str) -> bool {
    hklm()
        .open_subkey_with_flags(path, KEY_READ | KEY_WOW64_64KEY)
        .is_ok()
}

// ------------------------------------------------------------------ identity

pub fn identity() -> (Option<String>, Option<String>, Option<String>) {
    let product = cimv2("SELECT UUID, IdentifyingNumber FROM Win32_ComputerSystemProduct");
    let cs = cimv2("SELECT Domain, PartOfDomain FROM Win32_ComputerSystem");
    let uuid = product.first().and_then(|r| s(r, "UUID"));
    let serial = product.first().and_then(|r| s(r, "IdentifyingNumber"));
    let domain = cs.first().and_then(|r| {
        if b(r, "PartOfDomain") == Some(true) {
            s(r, "Domain")
        } else {
            None
        }
    });
    (uuid, serial, domain)
}

pub fn console_user() -> Option<String> {
    cimv2("SELECT UserName FROM Win32_ComputerSystem")
        .first()
        .and_then(|r| s(r, "UserName"))
}

// ------------------------------------------------------------------ system

pub(crate) fn pending_reboot_reasons() -> Vec<&'static str> {
    let mut reasons = Vec::new();
    if reg_key_exists(
        r"SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending",
    ) {
        reasons.push("component_servicing");
    }
    if reg_key_exists(
        r"SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired",
    ) {
        reasons.push("windows_update");
    }
    let renames = hklm()
        .open_subkey_with_flags(
            r"SYSTEM\CurrentControlSet\Control\Session Manager",
            KEY_READ,
        )
        .ok()
        .and_then(|k| {
            k.get_value::<Vec<String>, _>("PendingFileRenameOperations")
                .ok()
        })
        .is_some_and(|v| v.iter().any(|s| !s.trim().is_empty()));
    if renames {
        reasons.push("file_rename");
    }
    reasons
}

pub fn system(doc: &mut Map<String, Value>) {
    let os = cimv2(
        "SELECT Caption, Version, BuildNumber, OSArchitecture, InstallDate, LastBootUpTime, ProductType, RegisteredUser, Organization FROM Win32_OperatingSystem",
    );
    let cs = cimv2(
        "SELECT Domain, PartOfDomain, Workgroup, PCSystemType, Model, Manufacturer FROM Win32_ComputerSystem",
    );
    let os = os.first();
    let cs = cs.first();
    if let Some(os) = os
        && let Some(Value::Object(existing)) = doc.get_mut("os")
    {
        if let Some(caption) = s(os, "Caption") {
            existing.insert(
                "name".into(),
                json!(caption.trim_start_matches("Microsoft ").to_string()),
            );
        }
        existing.insert("version".into(), val(os, "Version"));
        existing.insert("build".into(), val(os, "BuildNumber"));
        existing.insert(
            "display_version".into(),
            opt_str(
                reg_string(
                    r"SOFTWARE\Microsoft\Windows NT\CurrentVersion",
                    "DisplayVersion",
                )
                .unwrap_or_default(),
            ),
        );
        existing.insert(
            "edition".into(),
            opt_str(
                reg_string(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion", "EditionID")
                    .unwrap_or_default(),
            ),
        );
        existing.insert("install_date".into(), date(os, "InstallDate"));
    }
    if let Some(os) = os {
        doc.insert("last_boot".into(), date(os, "LastBootUpTime"));
    }
    let product_type = os.and_then(|r| u(r, "ProductType")).unwrap_or(1);
    let pc_type = cs.and_then(|r| u(r, "PCSystemType")).unwrap_or(0);
    let model = cs
        .and_then(|r| s(r, "Model"))
        .unwrap_or_default()
        .to_lowercase();
    let device_type = if model.contains("virtual")
        || model.contains("vmware")
        || model.contains("kvm")
        || model.contains("hvm domu")
    {
        "virtual"
    } else if product_type != 1 {
        "server"
    } else if pc_type == 2 || pc_type == 8 {
        "laptop"
    } else {
        "workstation"
    };
    doc.insert("device_type".into(), json!(device_type));
    doc.insert("domain_controller".into(), json!(product_type == 2));
    if let Some(cs) = cs {
        let joined = b(cs, "PartOfDomain") == Some(true);
        doc.insert(
            "domain".into(),
            if joined {
                val(cs, "Domain")
            } else {
                Value::Null
            },
        );
        doc.insert(
            "workgroup".into(),
            if joined {
                Value::Null
            } else {
                val(cs, "Workgroup")
            },
        );
    }
    let azure_joined = reg_key_exists(r"SYSTEM\CurrentControlSet\Control\CloudDomainJoin\JoinInfo");
    doc.insert("entra_joined".into(), json!(azure_joined));
    let reasons = pending_reboot_reasons();
    doc.insert("pending_reboot".into(), json!(!reasons.is_empty()));
    doc.insert("pending_reboot_reasons".into(), json!(reasons));
}

// ------------------------------------------------------------------ hardware

fn decode_u16_string(value: &Value) -> Option<String> {
    let chars: String = value
        .as_array()?
        .iter()
        .filter_map(|c| c.as_u64())
        .filter(|c| *c != 0)
        .filter_map(|c| char::from_u32(c as u32))
        .collect();
    let chars = chars.trim().to_string();
    (!chars.is_empty()).then_some(chars)
}

pub fn hardware(doc: &mut Map<String, Value>) {
    if let Some(cs) = cimv2(
        "SELECT Manufacturer, Model, SystemFamily, TotalPhysicalMemory FROM Win32_ComputerSystem",
    )
    .first()
    {
        doc.insert("manufacturer".into(), val(cs, "Manufacturer"));
        doc.insert("model".into(), val(cs, "Model"));
        doc.insert("family".into(), val(cs, "SystemFamily"));
    }
    if let Some(p) =
        cimv2("SELECT UUID, IdentifyingNumber FROM Win32_ComputerSystemProduct").first()
    {
        doc.insert("uuid".into(), val(p, "UUID"));
        doc.insert("serial".into(), val(p, "IdentifyingNumber"));
    }
    if let Some(bios) =
        cimv2("SELECT Manufacturer, SMBIOSBIOSVersion, ReleaseDate, SerialNumber FROM Win32_BIOS")
            .first()
    {
        doc.insert("bios".into(), json!({ "vendor": val(bios, "Manufacturer"), "version": val(bios, "SMBIOSBIOSVersion"), "date": date(bios, "ReleaseDate") }));
        if doc.get("serial").is_none_or(Value::is_null) {
            doc.insert("serial".into(), val(bios, "SerialNumber"));
        }
    }
    if let Some(board) =
        cimv2("SELECT Manufacturer, Product, SerialNumber FROM Win32_BaseBoard").first()
    {
        doc.insert(
            "baseboard".into(),
            json!({ "manufacturer": val(board, "Manufacturer"), "product": val(board, "Product") }),
        );
    }
    if let Some(cpu) = cimv2(
        "SELECT Name, NumberOfCores, NumberOfLogicalProcessors, MaxClockSpeed FROM Win32_Processor",
    )
    .first()
        && let Some(Value::Object(existing)) = doc.get_mut("cpu")
    {
        existing.insert("model".into(), val(cpu, "Name"));
        existing.insert("cores".into(), val(cpu, "NumberOfCores"));
        existing.insert("threads".into(), val(cpu, "NumberOfLogicalProcessors"));
        existing.insert("mhz".into(), val(cpu, "MaxClockSpeed"));
    }
    let modules: Vec<Value> = cimv2("SELECT Capacity, Speed, Manufacturer, PartNumber, DeviceLocator FROM Win32_PhysicalMemory")
        .iter()
        .map(|m| json!({ "slot": val(m, "DeviceLocator"), "size_bytes": u(m, "Capacity"), "speed_mhz": val(m, "Speed"), "manufacturer": val(m, "Manufacturer"), "part_number": val(m, "PartNumber") }))
        .collect();
    if let Some(Value::Object(memory)) = doc.get_mut("memory") {
        memory.insert("modules".into(), Value::Array(modules));
    }
    let gpus: Vec<Value> = cimv2("SELECT Name, DriverVersion, AdapterRAM, VideoModeDescription FROM Win32_VideoController")
        .iter()
        .map(|g| json!({ "name": val(g, "Name"), "driver": val(g, "DriverVersion"), "memory_bytes": u(g, "AdapterRAM"), "mode": val(g, "VideoModeDescription") }))
        .collect();
    doc.insert("gpus".into(), Value::Array(gpus));
    let monitors: Vec<Value> = query("ROOT\\WMI", "SELECT ManufacturerName, UserFriendlyName, SerialNumberID, YearOfManufacture FROM WmiMonitorID")
        .iter()
        .map(|m| {
            json!({
                "manufacturer": decode_u16_string(&val(m, "ManufacturerName")),
                "model": decode_u16_string(&val(m, "UserFriendlyName")),
                "serial": decode_u16_string(&val(m, "SerialNumberID")),
                "year": val(m, "YearOfManufacture"),
            })
        })
        .collect();
    doc.insert("monitors".into(), Value::Array(monitors));
    let chassis = cimv2("SELECT ChassisTypes FROM Win32_SystemEnclosure")
        .first()
        .map(|r| val(r, "ChassisTypes"))
        .unwrap_or(Value::Null);
    doc.insert("chassis_types".into(), chassis);
    let batteries: Vec<Value> = cimv2("SELECT Name, EstimatedChargeRemaining, BatteryStatus, DesignCapacity, FullChargeCapacity FROM Win32_Battery")
        .iter()
        .map(|bat| json!({ "name": val(bat, "Name"), "charge_pct": val(bat, "EstimatedChargeRemaining"), "status": val(bat, "BatteryStatus"), "design_capacity": val(bat, "DesignCapacity"), "full_charge_capacity": val(bat, "FullChargeCapacity") }))
        .collect();
    doc.insert("batteries".into(), Value::Array(batteries));
    doc.insert(
        "secure_boot".into(),
        json!(
            reg_dword(
                r"SYSTEM\CurrentControlSet\Control\SecureBoot\State",
                "UEFISecureBootEnabled"
            )
            .map(|v| v == 1)
        ),
    );
    let tpm = query(
        "ROOT\\CIMV2\\Security\\MicrosoftTpm",
        "SELECT IsEnabled_InitialValue, IsActivated_InitialValue, SpecVersion, ManufacturerVersion FROM Win32_Tpm",
    );
    doc.insert(
        "tpm".into(),
        tpm.first()
            .map(|t| json!({ "present": true, "enabled": val(t, "IsEnabled_InitialValue"), "activated": val(t, "IsActivated_InitialValue"), "spec_version": val(t, "SpecVersion") }))
            .unwrap_or(Value::Null),
    );
    let printers: Vec<Value> = cimv2("SELECT Name, DriverName, PortName, Default, Network, Shared FROM Win32_Printer")
        .iter()
        .map(|p| json!({ "name": val(p, "Name"), "driver": val(p, "DriverName"), "port": val(p, "PortName"), "default": val(p, "Default"), "network": val(p, "Network") }))
        .collect();
    doc.insert("printers".into(), Value::Array(printers));
}

// ------------------------------------------------------------------ storage

pub fn storage(doc: &mut Map<String, Value>) {
    let disks: Vec<Value> = cimv2("SELECT Model, SerialNumber, Size, MediaType, InterfaceType, Status, Index FROM Win32_DiskDrive")
        .iter()
        .map(|d| json!({ "index": val(d, "Index"), "model": val(d, "Model"), "serial": val(d, "SerialNumber"), "size_bytes": u(d, "Size"), "media": val(d, "MediaType"), "bus": val(d, "InterfaceType"), "health": val(d, "Status") }))
        .collect();
    doc.insert("disks".into(), Value::Array(disks));
    let physical: Vec<Value> = query("ROOT\\Microsoft\\Windows\\Storage", "SELECT FriendlyName, MediaType, HealthStatus, BusType, Size FROM MSFT_PhysicalDisk")
        .iter()
        .map(|d| {
            let media = match u(d, "MediaType") { Some(3) => "hdd", Some(4) => "ssd", Some(5) => "scm", _ => "unknown" };
            let health = match u(d, "HealthStatus") { Some(0) => "healthy", Some(1) => "warning", Some(2) => "unhealthy", _ => "unknown" };
            json!({ "name": val(d, "FriendlyName"), "media": media, "health": health, "size_bytes": u(d, "Size") })
        })
        .collect();
    doc.insert("physical_disks".into(), Value::Array(physical));
    let bitlocker: Vec<Value> = query(
        "ROOT\\CIMV2\\Security\\MicrosoftVolumeEncryption",
        "SELECT DriveLetter, ProtectionStatus, VolumeType, ConversionStatus FROM Win32_EncryptableVolume",
    )
    .iter()
    .map(|v| json!({ "drive": val(v, "DriveLetter"), "protected": u(v, "ProtectionStatus") == Some(1), "os_volume": u(v, "VolumeType") == Some(0), "conversion_status": val(v, "ConversionStatus") }))
    .collect();
    doc.insert("bitlocker".into(), Value::Array(bitlocker));
}

// ------------------------------------------------------------------ network

pub fn network(doc: &mut Map<String, Value>) {
    let adapters = cimv2(
        "SELECT MACAddress, NetConnectionID, Speed, AdapterType, Manufacturer FROM Win32_NetworkAdapter WHERE NetEnabled = TRUE",
    );
    let configs = cimv2(
        "SELECT Description, MACAddress, IPAddress, IPSubnet, DefaultIPGateway, DNSServerSearchOrder, DHCPEnabled, DHCPServer, DNSDomain FROM Win32_NetworkAdapterConfiguration WHERE IPEnabled = TRUE",
    );
    let adapters_json: Vec<Value> = configs
        .iter()
        .map(|c| {
            let mac = s(c, "MACAddress").unwrap_or_default();
            let adapter = adapters
                .iter()
                .find(|a| s(a, "MACAddress").as_deref() == Some(mac.as_str()));
            json!({
                "name": adapter.and_then(|a| s(a, "NetConnectionID")),
                "description": val(c, "Description"),
                "mac": mac,
                "addresses": val(c, "IPAddress"),
                "subnets": val(c, "IPSubnet"),
                "gateways": val(c, "DefaultIPGateway"),
                "dns_servers": val(c, "DNSServerSearchOrder"),
                "dhcp": val(c, "DHCPEnabled"),
                "dhcp_server": val(c, "DHCPServer"),
                "dns_domain": val(c, "DNSDomain"),
                "speed_mbps": adapter.and_then(|a| u(a, "Speed")).map(|bps| bps / 1_000_000),
                "kind": adapter.map(|a| val(a, "AdapterType")),
            })
        })
        .collect();
    doc.insert("adapters".into(), Value::Array(adapters_json));
    if let Some(out) = crate::util::run_any(
        "netsh",
        &["wlan", "show", "interfaces"],
        Duration::from_secs(10),
    ) {
        let field = |name: &str| {
            out.lines()
                .find(|l| l.trim_start().starts_with(name))
                .and_then(|l| l.split_once(':'))
                .map(|(_, v)| v.trim().to_string())
        };
        if let Some(ssid) = field("SSID") {
            doc.insert(
                "wifi".into(),
                json!({ "ssid": ssid, "signal": field("Signal"), "radio": field("Radio type") }),
            );
        }
    }
}

// ------------------------------------------------------------------ software

fn read_uninstall(
    root: &RegKey,
    path: &str,
    scope: &str,
    out: &mut Vec<Value>,
    seen: &mut BTreeSet<(String, String)>,
) {
    let Ok(key) = root.open_subkey_with_flags(path, KEY_READ) else {
        return;
    };
    for name in key.enum_keys().flatten() {
        let Ok(app) = key.open_subkey_with_flags(&name, KEY_READ) else {
            continue;
        };
        let display: String = app.get_value("DisplayName").unwrap_or_default();
        let display = display.trim().to_string();
        if display.is_empty() {
            continue;
        }
        let system_component: u32 = app.get_value("SystemComponent").unwrap_or(0);
        let parent: String = app.get_value("ParentKeyName").unwrap_or_default();
        let release: String = app.get_value("ReleaseType").unwrap_or_default();
        if system_component == 1
            || !parent.is_empty()
            || matches!(release.as_str(), "Update" | "Hotfix" | "Security Update")
        {
            continue;
        }
        let version: String = app.get_value("DisplayVersion").unwrap_or_default();
        if !seen.insert((display.to_lowercase(), version.clone())) {
            continue;
        }
        let publisher: String = app.get_value("Publisher").unwrap_or_default();
        let install_date: String = app.get_value("InstallDate").unwrap_or_default();
        let size_kb: u32 = app.get_value("EstimatedSize").unwrap_or(0);
        let install_date = (install_date.len() == 8).then(|| {
            format!(
                "{}-{}-{}",
                &install_date[..4],
                &install_date[4..6],
                &install_date[6..8]
            )
        });
        out.push(json!({
            "name": display,
            "version": version.trim(),
            "publisher": publisher.trim(),
            "install_date": install_date,
            "size_bytes": (size_kb > 0).then_some(u64::from(size_kb) * 1024),
            "source": scope,
        }));
    }
}

pub fn software(doc: &mut Map<String, Value>) {
    let mut items = Vec::new();
    let mut seen = BTreeSet::new();
    let lm = hklm();
    read_uninstall(
        &lm,
        r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
        "machine",
        &mut items,
        &mut seen,
    );
    read_uninstall(
        &lm,
        r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
        "machine-x86",
        &mut items,
        &mut seen,
    );
    let users = RegKey::predef(HKEY_USERS);
    for sid in users
        .enum_keys()
        .flatten()
        .filter(|s| s.starts_with("S-1-5-21-") && !s.ends_with("_Classes"))
    {
        read_uninstall(
            &users,
            &format!(r"{sid}\Software\Microsoft\Windows\CurrentVersion\Uninstall"),
            "user",
            &mut items,
            &mut seen,
        );
    }
    items.sort_by(|a, b| {
        a["name"]
            .as_str()
            .unwrap_or("")
            .to_lowercase()
            .cmp(&b["name"].as_str().unwrap_or("").to_lowercase())
    });
    doc.insert("items".into(), Value::Array(items));
}

// ------------------------------------------------------------------ security

pub fn security(doc: &mut Map<String, Value>) {
    let mut antivirus: Vec<Value> = query("ROOT\\SecurityCenter2", "SELECT displayName, productState FROM AntiVirusProduct")
        .iter()
        .map(|av| {
            let state = u(av, "productState").unwrap_or(0);
            json!({ "name": val(av, "displayName"), "enabled": state & 0x1000 != 0, "up_to_date": state & 0x10 == 0, "source": "security_center" })
        })
        .collect();
    let defender = query(
        "ROOT\\Microsoft\\Windows\\Defender",
        "SELECT AMServiceEnabled, AntivirusEnabled, RealTimeProtectionEnabled, AntivirusSignatureAge, AntivirusSignatureLastUpdated, QuickScanEndTime, FullScanEndTime, IsTamperProtected FROM MSFT_MpComputerStatus",
    );
    if let Some(d) = defender.first() {
        let signature_age = u(d, "AntivirusSignatureAge");
        let details = json!({
            "service_enabled": val(d, "AMServiceEnabled"),
            "antivirus_enabled": val(d, "AntivirusEnabled"),
            "real_time_protection": val(d, "RealTimeProtectionEnabled"),
            "signature_age_days": signature_age,
            "signatures_updated": date(d, "AntivirusSignatureLastUpdated"),
            "last_quick_scan": date(d, "QuickScanEndTime"),
            "last_full_scan": date(d, "FullScanEndTime"),
            "tamper_protection": val(d, "IsTamperProtected"),
        });
        doc.insert("defender".into(), details);
        // Servers have no Security Center; report Defender itself.
        if antivirus.is_empty() {
            antivirus.push(json!({
                "name": "Microsoft Defender Antivirus",
                "enabled": b(d, "AntivirusEnabled").unwrap_or(false) && b(d, "RealTimeProtectionEnabled").unwrap_or(false),
                "up_to_date": signature_age.is_some_and(|a| a <= 3),
                "source": "defender",
            }));
        }
    }
    doc.insert("antivirus".into(), Value::Array(antivirus));

    let profiles: Vec<Value> = query(
        "ROOT\\StandardCimv2",
        "SELECT Name, Enabled FROM MSFT_NetFirewallProfile",
    )
    .iter()
    .map(|p| json!({ "name": val(p, "Name"), "enabled": b(p, "Enabled").unwrap_or(false) }))
    .collect();
    let all_on = !profiles.is_empty()
        && profiles
            .iter()
            .all(|p| p["enabled"].as_bool() == Some(true));
    doc.insert("firewall".into(), json!({ "enabled": if profiles.is_empty() { Value::Null } else { json!(all_on) }, "profiles": profiles }));

    let volumes = query(
        "ROOT\\CIMV2\\Security\\MicrosoftVolumeEncryption",
        "SELECT DriveLetter, ProtectionStatus, VolumeType FROM Win32_EncryptableVolume",
    );
    let os_volume = volumes.iter().find(|v| u(v, "VolumeType") == Some(0));
    doc.insert(
        "encryption".into(),
        json!({
            "method": "bitlocker",
            "system_volume_encrypted": os_volume.map(|v| u(v, "ProtectionStatus") == Some(1)),
            "volumes": volumes.iter().map(|v| json!({ "drive": val(v, "DriveLetter"), "protected": u(v, "ProtectionStatus") == Some(1) })).collect::<Vec<_>>(),
        }),
    );
    let policies = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System";
    doc.insert(
        "uac_enabled".into(),
        json!(reg_dword(policies, "EnableLUA").map(|v| v == 1)),
    );
    doc.insert(
        "rdp_enabled".into(),
        json!(
            reg_dword(
                r"SYSTEM\CurrentControlSet\Control\Terminal Server",
                "fDenyTSConnections"
            )
            .map(|v| v == 0)
        ),
    );
    doc.insert(
        "smb1_enabled".into(),
        json!(
            reg_dword(
                r"SYSTEM\CurrentControlSet\Services\LanmanServer\Parameters",
                "SMB1"
            )
            .map(|v| v == 1)
        ),
    );
    doc.insert(
        "autologon_enabled".into(),
        json!(
            reg_string(
                r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon",
                "AutoAdminLogon"
            )
            .map(|v| v.trim() == "1")
        ),
    );
    doc.insert(
        "secure_boot".into(),
        json!(
            reg_dword(
                r"SYSTEM\CurrentControlSet\Control\SecureBoot\State",
                "UEFISecureBootEnabled"
            )
            .map(|v| v == 1)
        ),
    );
    doc.insert(
        "local_admins".into(),
        json!(
            local_admins()
                .into_iter()
                .map(|(name, domain, _)| format!("{domain}\\{name}"))
                .collect::<Vec<_>>()
        ),
    );
}

/// Members of the local Administrators group (found by well-known SID, so any language works).
fn local_admins() -> Vec<(String, String, Option<String>)> {
    let group = cimv2(
        "SELECT Name, Domain FROM Win32_Group WHERE LocalAccount = TRUE AND SID = 'S-1-5-32-544'",
    );
    let Some(group) = group.first() else {
        return Vec::new();
    };
    let (Some(name), Some(domain)) = (s(group, "Name"), s(group, "Domain")) else {
        return Vec::new();
    };
    let wql = format!(
        "ASSOCIATORS OF {{Win32_Group.Domain='{}',Name='{}'}} WHERE AssocClass = Win32_GroupUser ResultRole = PartComponent",
        domain.replace('\'', "\\'"),
        name.replace('\'', "\\'")
    );
    cimv2(&wql)
        .iter()
        .filter_map(|m| {
            Some((
                s(m, "Name")?,
                s(m, "Domain").unwrap_or_default(),
                s(m, "SID"),
            ))
        })
        .collect()
}

// ------------------------------------------------------------------ users

pub fn users(doc: &mut Map<String, Value>) {
    let admin_sids: BTreeSet<String> = local_admins()
        .into_iter()
        .filter_map(|(_, _, sid)| sid)
        .collect();
    let local: Vec<Value> = cimv2("SELECT Name, FullName, Disabled, SID, Lockout, PasswordExpires FROM Win32_UserAccount WHERE LocalAccount = TRUE")
        .iter()
        .map(|a| {
            let sid = s(a, "SID").unwrap_or_default();
            json!({
                "name": val(a, "Name"),
                "full_name": val(a, "FullName"),
                "enabled": b(a, "Disabled").map(|d| !d),
                "locked": val(a, "Lockout"),
                "admin": admin_sids.contains(&sid),
                "builtin_administrator": sid.ends_with("-500"),
            })
        })
        .collect();
    doc.insert("local".into(), Value::Array(local));
    let logon = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Authentication\LogonUI";
    doc.insert(
        "last_user".into(),
        opt_str(reg_string(logon, "LastLoggedOnUser").unwrap_or_default()),
    );
    let console = console_user();
    doc.insert(
        "sessions".into(),
        json!(
            console
                .map(|u| vec![json!({ "user": u, "kind": "console" })])
                .unwrap_or_default()
        ),
    );
    let profiles: Vec<Value> = cimv2(
        "SELECT LocalPath, LastUseTime, Special FROM Win32_UserProfile WHERE Special = FALSE",
    )
    .iter()
    .map(|p| json!({ "path": val(p, "LocalPath"), "last_used": date(p, "LastUseTime") }))
    .collect();
    doc.insert("profiles".into(), Value::Array(profiles));
}

// ------------------------------------------------------------------ services & updates

pub fn services(doc: &mut Map<String, Value>) {
    let mut items: Vec<Value> = cimv2("SELECT Name, DisplayName, State, StartMode, StartName FROM Win32_Service")
        .iter()
        .map(|svc| json!({ "name": val(svc, "Name"), "display_name": val(svc, "DisplayName"), "state": val(svc, "State").as_str().map(str::to_lowercase), "start_mode": val(svc, "StartMode").as_str().map(str::to_lowercase), "account": val(svc, "StartName") }))
        .collect();
    items.sort_by(|a, b| {
        a["name"]
            .as_str()
            .unwrap_or("")
            .to_lowercase()
            .cmp(&b["name"].as_str().unwrap_or("").to_lowercase())
    });
    doc.insert("items".into(), Value::Array(items));
}

pub fn updates(doc: &mut Map<String, Value>) {
    let mut installed: Vec<Value> = cimv2("SELECT HotFixID, Description, InstalledOn, InstalledBy FROM Win32_QuickFixEngineering")
        .iter()
        .map(|h| json!({ "id": val(h, "HotFixID"), "description": val(h, "Description"), "installed_on": val(h, "InstalledOn") }))
        .collect();
    installed.sort_by(|a, b| b["id"].as_str().cmp(&a["id"].as_str()));
    doc.insert("installed".into(), Value::Array(installed));
    let reasons = pending_reboot_reasons();
    doc.insert("pending_reboot".into(), json!(!reasons.is_empty()));
    let wsus = reg_string(
        r"SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate",
        "WUServer",
    );
    doc.insert("wsus_server".into(), opt_str(wsus.unwrap_or_default()));
}

// ------------------------------------------------------------------ MSI install source

/// Reads `deploy.key` from the folder the MSI was installed from (GPO Software Installation can't
/// pass MSI properties, so the key ships as a sidecar file next to the package).
pub fn msi_sidecar_deploy_key() -> Option<String> {
    use windows::Win32::System::ApplicationInstallationAndServicing::MsiGetProductInfoW;
    use windows::core::{HSTRING, PWSTR};
    let product = HSTRING::from(MSI_PRODUCT_CODE);
    let property = HSTRING::from("InstallSource");
    let mut buf = vec![0u16; 1024];
    let mut len = buf.len() as u32;
    // SAFETY: buf/len describe a valid writable buffer for the duration of the call.
    let rc = unsafe {
        MsiGetProductInfoW(
            &product,
            &property,
            Some(PWSTR(buf.as_mut_ptr())),
            Some(&mut len),
        )
    };
    if rc != 0 {
        return None;
    }
    let source = String::from_utf16_lossy(&buf[..len as usize]);
    let path = std::path::Path::new(source.trim()).join("deploy.key");
    let text = std::fs::read_to_string(path).ok()?;
    let text = text.trim().to_string();
    (!text.is_empty()).then_some(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn product_code_matches_installer_definition() {
        let codes = include_str!("../../../../packaging/windows/product-codes.env");
        assert!(
            codes.contains(&format!("PRODUCT_CODE={MSI_PRODUCT_CODE}")),
            "agent and MSI must agree on the ProductCode"
        );
    }

    #[test]
    fn wmi_dates_convert_to_utc() {
        assert_eq!(
            wmi_date("20240115093045.000000-480").as_deref(),
            Some("2024-01-15T17:30:45+00:00")
        );
        assert_eq!(
            wmi_date("20240115093045.000000+060").as_deref(),
            Some("2024-01-15T08:30:45+00:00")
        );
        assert!(wmi_date("bad").is_none());
    }
}
