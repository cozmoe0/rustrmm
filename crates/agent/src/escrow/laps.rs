//! LAPS-style rotation of the managed local administrator: a CSPRNG password set through the
//! platform's own interfaces, never on a command line and never logged.
//!
//! * Windows: `NetUserSetInfo` (level 1003) / `NetUserAdd`, membership of the Administrators
//!   group resolved from its well-known SID (S-1-5-32-544), so localised names work.
//! * Linux: `useradd` (no secret), `usermod -aG sudo|wheel`, and `chpasswd` reading
//!   `user:password` from stdin.
//! * macOS: `dscl .` in interactive mode reading its commands (including `passwd`) from stdin.

use anyhow::{Result, bail};
use rustrmm_proto::escrow::{
    MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, RotateLocalAdmin, valid_account_name,
};
use zeroize::Zeroizing;

const UPPER: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ";
const LOWER: &[u8] = b"abcdefghijkmnopqrstuvwxyz";
const DIGITS: &[u8] = b"23456789";
/// Symbols that are safe for every platform's input path (no quotes, spaces, colons or
/// backslashes).
const SYMBOLS: &[u8] = b"!@#$%^&*-_=+?";

/// A uniformly random index below `n` (rejection sampling, no modulo bias).
fn random_below(n: usize) -> usize {
    debug_assert!(n > 0 && n <= 256);
    let limit = 256 - (256 % n);
    loop {
        let b = usize::from(rustrmm_crypto::random::bytes::<1>()[0]);
        if b < limit {
            return b % n;
        }
    }
}

/// A random password of `length` (clamped to 14–64) with at least one character of every class:
/// upper, lower, digits and, for `full`, symbols.
pub fn generate(length: u32, complexity: &str) -> Zeroizing<String> {
    let length = length.clamp(MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH) as usize;
    let classes: &[&[u8]] = if complexity == "alphanumeric" {
        &[UPPER, LOWER, DIGITS]
    } else {
        &[UPPER, LOWER, DIGITS, SYMBOLS]
    };
    let all: Vec<u8> = classes.concat();
    let mut chars: Zeroizing<Vec<u8>> = Zeroizing::new(Vec::with_capacity(length));
    for class in classes {
        chars.push(class[random_below(class.len())]);
    }
    while chars.len() < length {
        chars.push(all[random_below(all.len())]);
    }
    // Fisher–Yates, so the guaranteed characters are not always first.
    for i in (1..chars.len()).rev() {
        let j = random_below(i + 1);
        chars.swap(i, j);
    }
    Zeroizing::new(chars.iter().map(|b| *b as char).collect())
}

/// Outcome of a rotation (never the password).
#[derive(Debug, Clone, Default)]
pub struct Outcome {
    pub created: bool,
    pub group: String,
}

/// Sets `password` on the account, creating it and adding it to the administrators first when
/// asked to.
pub fn set_password(request: &RotateLocalAdmin, password: &str) -> Result<Outcome> {
    if !valid_account_name(&request.account) {
        bail!("invalid account name");
    }
    platform::set_password(request, password)
}

#[cfg(windows)]
mod platform {
    use anyhow::{Result, bail};
    use rustrmm_proto::escrow::RotateLocalAdmin;
    use windows::Win32::Foundation::ERROR_MEMBER_IN_ALIAS;
    use windows::Win32::NetworkManagement::NetManagement::{
        LOCALGROUP_MEMBERS_INFO_3, NERR_Success, NERR_UserNotFound, NetApiBufferFree,
        NetLocalGroupAddMembers, NetUserAdd, NetUserGetInfo, NetUserSetInfo, UF_ACCOUNTDISABLE,
        UF_DONT_EXPIRE_PASSWD, UF_SCRIPT, USER_INFO_1, USER_INFO_1003, USER_INFO_1008,
        USER_PRIV_USER,
    };
    use windows::Win32::Security::{
        CreateWellKnownSid, LookupAccountSidW, PSID, SID_NAME_USE, WinBuiltinAdministratorsSid,
    };
    use windows::core::{PCWSTR, PWSTR};
    use zeroize::Zeroizing;

    use super::Outcome;

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// The localised name of BUILTIN\Administrators.
    fn administrators_group() -> Result<String> {
        let mut sid = [0u8; 68];
        let mut size = sid.len() as u32;
        let mut name = [0u16; 256];
        let mut name_len = name.len() as u32;
        let mut domain = [0u16; 256];
        let mut domain_len = domain.len() as u32;
        let mut kind = SID_NAME_USE::default();
        // SAFETY: every buffer outlives the calls and its length is passed alongside.
        unsafe {
            CreateWellKnownSid(
                WinBuiltinAdministratorsSid,
                None,
                Some(PSID(sid.as_mut_ptr().cast())),
                &mut size,
            )?;
            LookupAccountSidW(
                PCWSTR::null(),
                PSID(sid.as_mut_ptr().cast()),
                Some(PWSTR(name.as_mut_ptr())),
                &mut name_len,
                Some(PWSTR(domain.as_mut_ptr())),
                &mut domain_len,
                &mut kind,
            )?;
        }
        Ok(String::from_utf16_lossy(&name[..name_len as usize]))
    }

    /// Account flags, or `None` when the account does not exist.
    fn account_flags(account: &[u16]) -> Result<Option<u32>> {
        let mut buf: *mut u8 = std::ptr::null_mut();
        // SAFETY: NetUserGetInfo allocates `buf`, freed below with NetApiBufferFree.
        let status =
            unsafe { NetUserGetInfo(PCWSTR::null(), PCWSTR(account.as_ptr()), 1, &mut buf) };
        if status == NERR_UserNotFound {
            return Ok(None);
        }
        if status != NERR_Success || buf.is_null() {
            bail!("NetUserGetInfo failed with {status}");
        }
        // SAFETY: level 1 returns a USER_INFO_1.
        let flags = unsafe { (*(buf as *const USER_INFO_1)).usri1_flags.0 };
        // SAFETY: `buf` came from the NetApi allocator.
        unsafe {
            NetApiBufferFree(Some(buf as *const _));
        }
        Ok(Some(flags))
    }

    pub fn set_password(request: &RotateLocalAdmin, password: &str) -> Result<Outcome> {
        let account = wide(&request.account);
        let mut secret = Zeroizing::new(wide(password));
        let mut outcome = Outcome::default();
        match account_flags(&account)? {
            Some(flags) => {
                let info = USER_INFO_1003 {
                    usri1003_password: PWSTR(secret.as_mut_ptr()),
                };
                // SAFETY: `info` points at a NUL-terminated buffer that outlives the call.
                let status = unsafe {
                    NetUserSetInfo(
                        PCWSTR::null(),
                        PCWSTR(account.as_ptr()),
                        1003,
                        (&info as *const USER_INFO_1003).cast(),
                        None,
                    )
                };
                if status != NERR_Success {
                    bail!("NetUserSetInfo failed with {status} (password policy or permissions)");
                }
                if flags & UF_ACCOUNTDISABLE.0 != 0 {
                    let enable = USER_INFO_1008 {
                        usri1008_flags:
                            windows::Win32::NetworkManagement::NetManagement::USER_ACCOUNT_FLAGS(
                                flags & !UF_ACCOUNTDISABLE.0,
                            ),
                    };
                    // SAFETY: as above.
                    let status = unsafe {
                        NetUserSetInfo(
                            PCWSTR::null(),
                            PCWSTR(account.as_ptr()),
                            1008,
                            (&enable as *const USER_INFO_1008).cast(),
                            None,
                        )
                    };
                    if status != NERR_Success {
                        bail!("enabling the account failed with {status}");
                    }
                }
            }
            None if request.create_if_missing => {
                let mut name = account.clone();
                let mut comment = wide("Managed by RustRMM");
                let info = USER_INFO_1 {
                    usri1_name: PWSTR(name.as_mut_ptr()),
                    usri1_password: PWSTR(secret.as_mut_ptr()),
                    usri1_priv: USER_PRIV_USER,
                    usri1_comment: PWSTR(comment.as_mut_ptr()),
                    usri1_flags:
                        windows::Win32::NetworkManagement::NetManagement::USER_ACCOUNT_FLAGS(
                            UF_SCRIPT.0 | UF_DONT_EXPIRE_PASSWD.0,
                        ),
                    ..Default::default()
                };
                // SAFETY: every string in `info` is NUL-terminated and outlives the call.
                let status = unsafe {
                    NetUserAdd(
                        PCWSTR::null(),
                        1,
                        (&info as *const USER_INFO_1).cast(),
                        None,
                    )
                };
                if status != NERR_Success {
                    bail!("NetUserAdd failed with {status} (password policy or permissions)");
                }
                outcome.created = true;
            }
            None => bail!("the account does not exist and create_if_missing is off"),
        }
        let group = administrators_group()?;
        let group_w = wide(&group);
        let mut member = account.clone();
        let info = LOCALGROUP_MEMBERS_INFO_3 {
            lgrmi3_domainandname: PWSTR(member.as_mut_ptr()),
        };
        // SAFETY: `info` points at a NUL-terminated buffer that outlives the call.
        let status = unsafe {
            NetLocalGroupAddMembers(
                PCWSTR::null(),
                PCWSTR(group_w.as_ptr()),
                3,
                (&info as *const LOCALGROUP_MEMBERS_INFO_3).cast(),
                1,
            )
        };
        if status != NERR_Success && status != ERROR_MEMBER_IN_ALIAS.0 {
            bail!("adding the account to {group} failed with {status}");
        }
        secret.fill(0);
        outcome.group = group;
        Ok(outcome)
    }
}

#[cfg(unix)]
mod platform {
    use std::io::Write;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    use anyhow::{Context, Result, bail};
    use rustrmm_proto::escrow::RotateLocalAdmin;

    use super::Outcome;

    /// Runs a system tool with a minimal environment, writing `stdin` (which may carry a secret:
    /// it never appears in arguments, the environment or logs).
    fn run(tool: &str, args: &[&str], stdin: Option<&[u8]>) -> Result<()> {
        let program = crate::util::system_tool(tool);
        let mut child = Command::new(&program)
            .args(args)
            .env_clear()
            .env("PATH", "/usr/sbin:/usr/bin:/sbin:/bin")
            .env("LANG", "C")
            .stdin(if stdin.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .with_context(|| format!("cannot start {tool}"))?;
        if let (Some(data), Some(mut pipe)) = (stdin, child.stdin.take()) {
            pipe.write_all(data).context("writing to the tool")?;
        }
        let started = Instant::now();
        loop {
            if let Some(status) = child.try_wait()? {
                if status.success() {
                    return Ok(());
                }
                let mut err = String::new();
                if let Some(e) = child.stderr.take() {
                    use std::io::Read;
                    let _ = e.take(4096).read_to_string(&mut err);
                }
                bail!(
                    "{tool} failed ({status}): {}",
                    err.lines().next().unwrap_or("").trim()
                );
            }
            if started.elapsed() > Duration::from_secs(60) {
                let _ = child.kill();
                bail!("{tool} timed out");
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    }

    #[cfg(target_os = "linux")]
    fn local_account_exists(account: &str) -> bool {
        std::fs::read_to_string("/etc/passwd")
            .map(|t| t.lines().any(|l| l.split(':').next() == Some(account)))
            .unwrap_or(false)
    }

    #[cfg(target_os = "linux")]
    fn admin_group() -> Option<&'static str> {
        let groups = std::fs::read_to_string("/etc/group").unwrap_or_default();
        ["sudo", "wheel"]
            .into_iter()
            .find(|g| groups.lines().any(|l| l.split(':').next() == Some(*g)))
    }

    #[cfg(target_os = "linux")]
    pub fn set_password(request: &RotateLocalAdmin, password: &str) -> Result<Outcome> {
        let mut outcome = Outcome::default();
        if !local_account_exists(&request.account) {
            if !request.create_if_missing {
                bail!("the account does not exist and create_if_missing is off");
            }
            run(
                "useradd",
                &[
                    "-m",
                    "-s",
                    "/bin/bash",
                    "-c",
                    "Managed by RustRMM",
                    &request.account,
                ],
                None,
            )?;
            outcome.created = true;
        }
        let group = admin_group().context("neither a sudo nor a wheel group exists")?;
        run("usermod", &["-aG", group, &request.account], None)?;
        let mut line =
            zeroize::Zeroizing::new(format!("{}:{password}\n", request.account).into_bytes());
        let result = run("chpasswd", &[], Some(&line));
        zeroize::Zeroize::zeroize(&mut *line);
        result?;
        outcome.group = group.into();
        Ok(outcome)
    }

    #[cfg(target_os = "macos")]
    pub fn set_password(request: &RotateLocalAdmin, password: &str) -> Result<Outcome> {
        let mut outcome = Outcome::default();
        let user = format!("/Users/{}", request.account);
        let exists = crate::util::run_capture(
            &crate::util::system_tool("dscl"),
            &[".", "-read", &user, "UniqueID"],
            Duration::from_secs(20),
        )
        .map(|c| c.code == Some(0))
        .unwrap_or(false);
        let mut script = String::new();
        if !exists {
            if !request.create_if_missing {
                bail!("the account does not exist and create_if_missing is off");
            }
            // A free UID below 500 keeps the account off the login window.
            let listing = crate::util::run_capture(
                &crate::util::system_tool("dscl"),
                &[".", "-list", "/Users", "UniqueID"],
                Duration::from_secs(20),
            )?;
            let used: Vec<u32> = listing
                .stdout
                .lines()
                .filter_map(|l| l.split_whitespace().nth(1)?.parse().ok())
                .collect();
            let uid = (401..500)
                .find(|u| !used.contains(u))
                .context("no free UID")?;
            for (key, value) in [
                ("UserShell", "/usr/bin/false".to_string()),
                ("RealName", "RustRMM managed admin".to_string()),
                ("UniqueID", uid.to_string()),
                ("PrimaryGroupID", "20".to_string()),
                ("NFSHomeDirectory", "/var/empty".to_string()),
                ("IsHidden", "1".to_string()),
            ] {
                script.push_str(&format!("create {user} {key} \"{value}\"\n"));
            }
            outcome.created = true;
        }
        // Quoted: the generated alphabet has no quotes or backslashes.
        script.push_str(&format!("passwd {user} \"{password}\"\n"));
        script.push_str(&format!(
            "append /Groups/admin GroupMembership {}\n",
            request.account
        ));
        script.push_str("quit\n");
        let mut bytes = zeroize::Zeroizing::new(script.into_bytes());
        let result = run("dscl", &["."], Some(&bytes));
        zeroize::Zeroize::zeroize(&mut *bytes);
        result?;
        outcome.group = "admin".into();
        Ok(outcome)
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    pub fn set_password(_request: &RotateLocalAdmin, _password: &str) -> Result<Outcome> {
        bail!("local administrator rotation is not supported on this platform")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passwords_have_every_class_and_the_right_length() {
        for _ in 0..200 {
            let p = generate(20, "full");
            assert_eq!(p.len(), 20);
            assert!(p.bytes().any(|b| UPPER.contains(&b)));
            assert!(p.bytes().any(|b| LOWER.contains(&b)));
            assert!(p.bytes().any(|b| DIGITS.contains(&b)));
            assert!(p.bytes().any(|b| SYMBOLS.contains(&b)));
            assert!(p.bytes().all(|b| UPPER.contains(&b)
                || LOWER.contains(&b)
                || DIGITS.contains(&b)
                || SYMBOLS.contains(&b)));
            let a = generate(16, "alphanumeric");
            assert_eq!(a.len(), 16);
            assert!(a.bytes().all(|b| b.is_ascii_alphanumeric()));
            assert!(a.bytes().any(|b| b.is_ascii_digit()));
        }
        assert_eq!(
            generate(4, "full").len(),
            MIN_PASSWORD_LENGTH as usize,
            "clamped up"
        );
        assert_eq!(
            generate(500, "full").len(),
            MAX_PASSWORD_LENGTH as usize,
            "clamped down"
        );
        assert_ne!(*generate(20, "full"), *generate(20, "full"));
        // Rejection sampling stays in range.
        for n in [1, 7, 13, 24, 57, 256] {
            for _ in 0..50 {
                assert!(random_below(n) < n);
            }
        }
    }

    #[test]
    fn refuses_bad_account_names_before_touching_the_system() {
        let request = RotateLocalAdmin {
            account: "bad name; rm -rf".into(),
            ..RotateLocalAdmin::default()
        };
        assert!(set_password(&request, "x").is_err());
    }
}
