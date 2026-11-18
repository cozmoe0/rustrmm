//! The operating system's ARP (neighbour) table: `/proc/net/arp` on Linux, `arp -a` on Windows
//! and `arp -an` on macOS (system tools by absolute path).

use std::net::Ipv4Addr;

/// `aa:bb:cc:dd:ee:ff` from any common notation (also macOS's `0:1b:a9:1:2:3`); `None` for
/// incomplete, broadcast and multicast entries.
pub fn normalize_mac(text: &str) -> Option<String> {
    let parts: Vec<&str> = text.split([':', '-']).collect();
    let octets: Vec<u8> = if parts.len() == 6 {
        parts
            .iter()
            .map(|p| {
                u8::from_str_radix(p, 16)
                    .ok()
                    .filter(|_| !p.is_empty() && p.len() <= 2)
            })
            .collect::<Option<Vec<u8>>>()?
    } else {
        let hex: String = text.chars().filter(char::is_ascii_hexdigit).collect();
        if hex.len() != 12 {
            return None;
        }
        (0..6)
            .map(|i| u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).ok())
            .collect::<Option<Vec<u8>>>()?
    };
    if octets.iter().all(|b| *b == 0) || octets.iter().all(|b| *b == 0xFF) || octets[0] & 1 == 1 {
        return None;
    }
    Some(
        octets
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<Vec<_>>()
            .join(":"),
    )
}

/// Linux `/proc/net/arp`.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn parse_proc(text: &str) -> Vec<(Ipv4Addr, String)> {
    text.lines()
        .skip(1)
        .filter_map(|line| {
            let cols: Vec<&str> = line.split_whitespace().collect();
            let ip: Ipv4Addr = cols.first()?.parse().ok()?;
            let flags = u32::from_str_radix(cols.get(2)?.trim_start_matches("0x"), 16).ok()?;
            if flags & 0x2 == 0 {
                return None; // incomplete
            }
            Some((ip, normalize_mac(cols.get(3)?)?))
        })
        .collect()
}

/// Windows `arp -a`: `  192.168.1.1     aa-bb-cc-dd-ee-ff     dynamic` (headers are localised,
/// data lines are not).
#[cfg_attr(not(windows), allow(dead_code))]
pub fn parse_windows(text: &str) -> Vec<(Ipv4Addr, String)> {
    text.lines()
        .filter_map(|line| {
            let cols: Vec<&str> = line.split_whitespace().collect();
            if cols.len() < 2 {
                return None;
            }
            let ip: Ipv4Addr = cols[0].parse().ok()?;
            Some((ip, normalize_mac(cols[1])?))
        })
        .collect()
}

/// BSD/macOS `arp -an`: `? (192.168.1.1) at 0:1b:a9:1:2:3 on en0 ifscope [ethernet]`.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn parse_bsd(text: &str) -> Vec<(Ipv4Addr, String)> {
    text.lines()
        .filter_map(|line| {
            let start = line.find('(')? + 1;
            let end = line[start..].find(')')? + start;
            let ip: Ipv4Addr = line[start..end].parse().ok()?;
            let rest = &line[end..];
            let mac = rest.split_whitespace().skip_while(|w| *w != "at").nth(1)?;
            Some((ip, normalize_mac(mac)?))
        })
        .collect()
}

/// The current table (empty when it cannot be read).
pub fn read_table() -> Vec<(Ipv4Addr, String)> {
    #[cfg(target_os = "linux")]
    {
        std::fs::read_to_string("/proc/net/arp")
            .map(|t| parse_proc(&t))
            .unwrap_or_default()
    }
    #[cfg(windows)]
    {
        let tool = crate::util::system_tool("arp");
        crate::util::run_capture(&tool, &["-a"], std::time::Duration::from_secs(10))
            .map(|c| parse_windows(&c.stdout))
            .unwrap_or_default()
    }
    #[cfg(target_os = "macos")]
    {
        let tool = crate::util::system_tool("arp");
        crate::util::run_capture(&tool, &["-an"], std::time::Duration::from_secs(10))
            .map(|c| parse_bsd(&c.stdout))
            .unwrap_or_default()
    }
    #[cfg(not(any(target_os = "linux", windows, target_os = "macos")))]
    {
        Vec::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_arp_tables() {
        let proc = "IP address       HW type     Flags       HW address            Mask     Device\n\
                    192.168.1.1      0x1         0x2         00:11:32:aa:bb:cc     *        eth0\n\
                    192.168.1.9      0x1         0x0         00:00:00:00:00:00     *        eth0\n\
                    192.168.1.20     0x1         0x6         B8:27:EB:01:02:03     *        eth0\n";
        assert_eq!(
            parse_proc(proc),
            vec![
                (
                    "192.168.1.1".parse().expect("ip"),
                    "00:11:32:aa:bb:cc".into()
                ),
                (
                    "192.168.1.20".parse().expect("ip"),
                    "b8:27:eb:01:02:03".into()
                ),
            ]
        );
        let windows = "\nInterface: 192.168.1.50 --- 0xb\n  Internet Address      Physical Address      Type\n  \
                       192.168.1.1           00-11-32-aa-bb-cc     dynamic   \n  \
                       192.168.1.255         ff-ff-ff-ff-ff-ff     static    \n  \
                       224.0.0.22            01-00-5e-00-00-16     static    \n";
        assert_eq!(
            parse_windows(windows),
            vec![(
                "192.168.1.1".parse().expect("ip"),
                "00:11:32:aa:bb:cc".into()
            )]
        );
        let bsd = "? (192.168.1.1) at 0:1b:a9:1:2:3 on en0 ifscope [ethernet]\n\
                   ? (192.168.1.7) at (incomplete) on en0 ifscope [ethernet]\n";
        assert_eq!(
            parse_bsd(bsd),
            vec![(
                "192.168.1.1".parse().expect("ip"),
                "00:1b:a9:01:02:03".into()
            )]
        );
        assert_eq!(
            normalize_mac("0011.32aa.bbcc").as_deref(),
            Some("00:11:32:aa:bb:cc")
        );
    }
}
