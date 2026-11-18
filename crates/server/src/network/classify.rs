//! Device type guessing for discovered assets: `sysObjectID` enterprise numbers and `sysDescr`
//! keywords first, then telling open ports (9100 printer, 554 camera, 5000/5001 NAS), the OUI
//! vendor, mDNS service types, and finally operating-system hints.

/// Every type an asset can have.
pub const TYPES: &[&str] = &[
    "printer", "switch", "router", "ap", "nas", "camera", "phone", "windows", "linux", "mac",
    "ups", "unknown",
];

/// What a scan learned about a host.
#[derive(Debug, Default, Clone, Copy)]
pub struct Facts<'a> {
    pub vendor: Option<&'a str>,
    pub sys_object_id: Option<&'a str>,
    pub sys_descr: Option<&'a str>,
    pub open_ports: &'a [u16],
    pub mdns: &'a [String],
    pub netbios_name: Option<&'a str>,
}

const PRINTER_WORDS: &[&str] = &[
    "printer",
    "laserjet",
    "jetdirect",
    "officejet",
    "deskjet",
    "imagerunner",
    "imageclass",
    "workcentre",
    "versalink",
    "altalink",
    "bizhub",
    "ecosys",
    "taskalfa",
    "pixma",
    "mfc-",
    "hl-",
    "aficio",
    "lexmark",
    "zebra",
    "page printer",
    "brother",
    "epson",
    "kyocera",
    "ricoh",
    "xerox",
    "canon",
];
const UPS_WORDS: &[&str] = &[
    "smart-ups",
    "powerware",
    "network management card",
    "powerchute",
    "cyberpower",
];
const NAS_WORDS: &[&str] = &[
    "synology",
    "diskstation",
    "rackstation",
    "qnap",
    "readynas",
    "truenas",
    "freenas",
    "nas ",
];
const CAMERA_WORDS: &[&str] = &[
    "camera",
    "ipcam",
    "ip cam",
    "network video",
    "nvr",
    "dvr",
    "hikvision",
    "dahua",
    "axis ",
];
const AP_WORDS: &[&str] = &[
    "access point",
    "aironet",
    "unifi ap",
    "uap-",
    "wireless lan",
    " wap",
];
const ROUTER_WORDS: &[&str] = &[
    "router",
    "routeros",
    "fortigate",
    "fortios",
    "pan-os",
    "sonicos",
    "edgeos",
    "pfsense",
    "opnsense",
    "firewall",
    "vyos",
    "isr",
    "asa ",
    "adaptive security",
];
const SWITCH_WORDS: &[&str] = &[
    "switch",
    "catalyst",
    "procurve",
    "nexus",
    "arubaos-cx",
    "extremexos",
    "icx",
    "eos ",
];
const PHONE_WORDS: &[&str] = &["phone", "sip ", "voip", "yealink", "polycom"];

fn has_any(text: &str, words: &[&str]) -> bool {
    words.iter().any(|w| text.contains(w))
}

/// `word` appears as a whole alphanumeric token (so "ups" does not match "groups").
fn has_token(text: &str, word: &str) -> bool {
    text.split(|c: char| !c.is_ascii_alphanumeric())
        .any(|t| t == word)
}

/// Type from `sysObjectID` (enterprise number under 1.3.6.1.4.1), refined by `sysDescr`.
fn from_enterprise(oid: &str, descr: &str) -> Option<&'static str> {
    let rest = oid.trim_start_matches('.').strip_prefix("1.3.6.1.4.1.")?;
    let enterprise: u32 = rest.split('.').next()?.parse().ok()?;
    Some(match enterprise {
        // Cisco: decide between access point, router and switch from the description.
        9 => {
            if has_any(descr, AP_WORDS) || descr.contains("air-") {
                "ap"
            } else if has_any(descr, ROUTER_WORDS) {
                "router"
            } else {
                "switch"
            }
        }
        11 | 232 => {
            if has_any(descr, PRINTER_WORDS) {
                "printer"
            } else if has_any(descr, SWITCH_WORDS) {
                "switch"
            } else {
                return None;
            }
        }
        2636 => {
            if descr.contains("ex") && has_any(descr, SWITCH_WORDS) {
                "switch"
            } else {
                "router"
            }
        }
        30065 | 1916 | 1588 | 207 => "switch",
        318 | 534 | 705 | 3808 | 850 | 935 => "ups",
        6574 | 24681 | 4413 => "nas",
        1347 | 1602 | 1248 | 2435 | 367 | 253 | 641 | 18334 | 10642 | 2385 => "printer",
        14988 | 12356 | 25461 | 8741 | 3097 | 2620 | 7779 => "router",
        41112 => {
            if has_any(descr, ROUTER_WORDS) {
                "router"
            } else {
                "ap"
            }
        }
        25053 | 14823 | 29671 => "ap",
        368 | 39165 | 1004849 => "camera",
        311 => "windows",
        63 => "mac",
        _ => return None,
    })
}

/// Best guess for an asset's type (`unknown` when nothing is telling).
pub fn guess(f: &Facts<'_>) -> &'static str {
    let descr = f.sys_descr.unwrap_or_default().to_ascii_lowercase();
    if let Some(t) = f.sys_object_id.and_then(|oid| from_enterprise(oid, &descr)) {
        return t;
    }
    if !descr.is_empty() {
        for (words, kind) in [
            (PRINTER_WORDS, "printer"),
            (UPS_WORDS, "ups"),
            (NAS_WORDS, "nas"),
            (CAMERA_WORDS, "camera"),
            (AP_WORDS, "ap"),
            (ROUTER_WORDS, "router"),
            (SWITCH_WORDS, "switch"),
            (PHONE_WORDS, "phone"),
        ] {
            if has_any(&descr, words) || (kind == "ups" && has_token(&descr, "ups")) {
                return kind;
            }
        }
    }
    let port = |p: u16| f.open_ports.contains(&p);
    if port(9100) || port(515) {
        return "printer";
    }
    if port(554) {
        return "camera";
    }
    let vendor = f.vendor.unwrap_or_default().to_ascii_lowercase();
    if !vendor.is_empty() {
        let v = |names: &[&str]| names.iter().any(|n| vendor.contains(n));
        if v(&[
            "brother", "canon", "epson", "ricoh", "xerox", "kyocera", "lexmark", "konica", "zebra",
        ]) {
            return "printer";
        }
        if v(&[
            "hikvision",
            "dahua",
            "axis",
            "hanwha",
            "vivotek",
            "mobotix",
            "bosch",
        ]) {
            return "camera";
        }
        if v(&["american power", "eaton", "cyberpower", "tripp lite"]) {
            return "ups";
        }
        if v(&["synology", "qnap", "western digital"]) {
            return "nas";
        }
        if v(&[
            "polycom",
            "yealink",
            "grandstream",
            "avaya",
            "mitel",
            "snom",
        ]) {
            return "phone";
        }
        if v(&["ruckus", "aruba", "ubiquiti", "meraki"]) {
            return "ap";
        }
        if v(&["arista", "extreme", "brocade", "allied telesis"]) {
            return "switch";
        }
        if v(&[
            "fortinet",
            "palo alto",
            "sonicwall",
            "watchguard",
            "sophos",
            "check point",
            "draytek",
            "mikrotik",
        ]) {
            return "router";
        }
    }
    if port(5000) || port(5001) {
        return "nas";
    }
    if port(5060) || port(5061) {
        return "phone";
    }
    let mdns = |needle: &str| {
        f.mdns
            .iter()
            .any(|s| s.to_ascii_lowercase().contains(needle))
    };
    if mdns("_ipp.") || mdns("_ipps.") || mdns("_printer.") || mdns("_pdl-datastream.") {
        return "printer";
    }
    if mdns("_rtsp.") {
        return "camera";
    }
    if port(3389) || (port(445) && f.netbios_name.is_some()) || descr.contains("windows") {
        return "windows";
    }
    if vendor.contains("apple")
        || port(548)
        || mdns("_afpovertcp.")
        || descr.contains("darwin")
        || descr.contains("macos")
    {
        return "mac";
    }
    if descr.contains("linux") || vendor.contains("raspberry") || (port(22) && !port(445)) {
        return "linux";
    }
    if port(445) || f.netbios_name.is_some() {
        return "windows";
    }
    "unknown"
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts<'a>(ports: &'a [u16]) -> Facts<'a> {
        Facts {
            open_ports: ports,
            ..Facts::default()
        }
    }

    #[test]
    fn type_guessing() {
        // sysObjectID wins, refined by sysDescr.
        let f = Facts {
            sys_object_id: Some("1.3.6.1.4.1.9.1.2066"),
            sys_descr: Some("Cisco IOS Software, Catalyst L3 Switch Software"),
            ..Facts::default()
        };
        assert_eq!(guess(&f), "switch");
        let f = Facts {
            sys_object_id: Some(".1.3.6.1.4.1.9.1.1874"),
            sys_descr: Some("Cisco IOS Software, C800 Software (C800-UNIVERSALK9-M), ISR router"),
            ..Facts::default()
        };
        assert_eq!(guess(&f), "router");
        let f = Facts {
            sys_object_id: Some("1.3.6.1.4.1.11.2.3.9.1"),
            sys_descr: Some("HP ETHERNET MULTI-ENVIRONMENT,ROM none,JETDIRECT,JD153"),
            ..Facts::default()
        };
        assert_eq!(guess(&f), "printer");
        let f = Facts {
            sys_object_id: Some("1.3.6.1.4.1.318.1.3.27"),
            ..Facts::default()
        };
        assert_eq!(guess(&f), "ups");
        let f = Facts {
            sys_object_id: Some("1.3.6.1.4.1.6574.1"),
            ..Facts::default()
        };
        assert_eq!(guess(&f), "nas");
        // sysDescr keywords without a known enterprise.
        let f = Facts {
            sys_object_id: Some("1.3.6.1.4.1.99999.1"),
            sys_descr: Some("Brother NC-8300w, Firmware Ver.1.10  (12.06.22),MID 8C5-E41,FID 2"),
            ..Facts::default()
        };
        assert_eq!(guess(&f), "printer");
        let f = Facts {
            sys_descr: Some("Linux nas01 4.4.302+ #72806 SMP Synology DiskStation"),
            ..Facts::default()
        };
        assert_eq!(guess(&f), "nas");
        let f = Facts {
            sys_descr: Some("Eaton 5PX UPS network card"),
            ..Facts::default()
        };
        assert_eq!(guess(&f), "ups");
        let f = Facts {
            sys_descr: Some("Linux backups-and-groups 5.15"),
            ..Facts::default()
        };
        assert_eq!(guess(&f), "linux", "ups only as a whole word");
        // Ports.
        assert_eq!(guess(&facts(&[80, 443, 9100])), "printer");
        assert_eq!(guess(&facts(&[80, 554])), "camera");
        assert_eq!(guess(&facts(&[5000, 5001, 22])), "nas");
        assert_eq!(guess(&facts(&[135, 3389, 445])), "windows");
        assert_eq!(guess(&facts(&[22])), "linux");
        assert_eq!(guess(&facts(&[5060])), "phone");
        assert_eq!(guess(&facts(&[])), "unknown");
        // Vendor.
        let f = Facts {
            vendor: Some("Hikvision"),
            open_ports: &[80],
            ..Facts::default()
        };
        assert_eq!(guess(&f), "camera");
        let f = Facts {
            vendor: Some("American Power Conversion"),
            ..Facts::default()
        };
        assert_eq!(guess(&f), "ups");
        let f = Facts {
            vendor: Some("Apple"),
            ..Facts::default()
        };
        assert_eq!(guess(&f), "mac");
        let f = Facts {
            vendor: Some("Ubiquiti"),
            open_ports: &[22, 443],
            ..Facts::default()
        };
        assert_eq!(guess(&f), "ap");
        // mDNS and NetBIOS.
        let services = vec!["_ipp._tcp.local".to_string()];
        let f = Facts {
            mdns: &services,
            ..Facts::default()
        };
        assert_eq!(guess(&f), "printer");
        let f = Facts {
            netbios_name: Some("WS-ACCT-01"),
            open_ports: &[445],
            ..Facts::default()
        };
        assert_eq!(guess(&f), "windows");
        for t in TYPES {
            assert!(t.len() <= 8);
        }
    }
}
