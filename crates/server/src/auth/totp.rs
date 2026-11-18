//! RFC 6238 TOTP (HMAC-SHA1, 30-second steps, 6 digits) — the parameters every authenticator
//! app supports.

use hmac::{Hmac, KeyInit, Mac};
use sha1::Sha1;

pub const STEP_SECONDS: u64 = 30;
pub const DIGITS: u32 = 6;
pub const SECRET_LEN: usize = 20;

pub fn generate_secret() -> [u8; SECRET_LEN] {
    rustrmm_crypto::random::bytes::<SECRET_LEN>()
}

/// RFC 4648 base32 without padding (what authenticator apps expect).
pub fn to_base32(secret: &[u8]) -> String {
    data_encoding::BASE32_NOPAD.encode(secret)
}

pub fn current_step(unix_seconds: u64) -> u64 {
    unix_seconds / STEP_SECONDS
}

/// The code for a given step.
pub fn code_at(secret: &[u8], step: u64) -> u32 {
    let mut mac =
        <Hmac<Sha1> as KeyInit>::new_from_slice(secret).expect("HMAC accepts any key length");
    mac.update(&step.to_be_bytes());
    let digest = mac.finalize().into_bytes();
    let offset = (digest[digest.len() - 1] & 0x0f) as usize;
    let binary = (u32::from(digest[offset]) & 0x7f) << 24
        | u32::from(digest[offset + 1]) << 16
        | u32::from(digest[offset + 2]) << 8
        | u32::from(digest[offset + 3]);
    binary % 10u32.pow(DIGITS)
}

/// Checks `code` against the current step ±1. Returns the matched step, which must be stored and
/// passed back as `last_used_step` so the same code cannot be replayed.
pub fn verify(
    secret: &[u8],
    code: &str,
    unix_seconds: u64,
    last_used_step: Option<i64>,
) -> Option<u64> {
    let code = code.trim().replace([' ', '-'], "");
    if code.len() != DIGITS as usize || !code.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let candidate: u32 = code.parse().ok()?;
    let now = current_step(unix_seconds);
    for step in [now.saturating_sub(1), now, now + 1] {
        if let Some(last) = last_used_step
            && step as i64 <= last
        {
            continue;
        }
        if rustrmm_crypto::random::ct_eq(
            &code_at(secret, step).to_be_bytes(),
            &candidate.to_be_bytes(),
        ) {
            return Some(step);
        }
    }
    None
}

/// `otpauth://` provisioning URI.
pub fn otpauth_url(issuer: &str, account: &str, secret_b32: &str) -> String {
    let label = format!("{}:{}", encode(issuer), encode(account));
    format!(
        "otpauth://totp/{label}?secret={secret_b32}&issuer={}&algorithm=SHA1&digits={DIGITS}&period={STEP_SECONDS}",
        encode(issuer)
    )
}

fn encode(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes())
        .collect::<String>()
        .replace('+', "%20")
}

/// Renders `data` as an SVG QR code.
pub fn qr_svg(data: &str) -> anyhow::Result<String> {
    let code = qrcode::QrCode::with_error_correction_level(data.as_bytes(), qrcode::EcLevel::M)
        .map_err(|e| anyhow::anyhow!("QR encoding failed: {e}"))?;
    Ok(code
        .render::<qrcode::render::svg::Color>()
        .min_dimensions(200, 200)
        .quiet_zone(true)
        .dark_color(qrcode::render::svg::Color("#0c0e11"))
        .light_color(qrcode::render::svg::Color("#ffffff"))
        .build())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// RFC 6238 appendix B test vectors (SHA-1, 8 digits) truncated to 6 digits.
    #[test]
    fn rfc6238_vectors() {
        let secret = b"12345678901234567890";
        assert_eq!(code_at(secret, 59 / 30), 287_082);
        assert_eq!(code_at(secret, 1_111_111_109 / 30), 81_804);
        assert_eq!(code_at(secret, 1_234_567_890 / 30), 5_924);
    }

    #[test]
    fn verify_window_and_replay() {
        let secret = generate_secret();
        let now = 1_700_000_000u64;
        let code = format!("{:06}", code_at(&secret, current_step(now)));
        let step = verify(&secret, &code, now, None).expect("valid");
        assert!(
            verify(&secret, &code, now, Some(step as i64)).is_none(),
            "replay rejected"
        );
        let previous = format!("{:06}", code_at(&secret, current_step(now) - 1));
        assert!(
            verify(&secret, &previous, now, None).is_some(),
            "one step of drift allowed"
        );
        let old = format!("{:06}", code_at(&secret, current_step(now) - 3));
        assert!(verify(&secret, &old, now, None).is_none());
        assert!(verify(&secret, "12345", now, None).is_none());
    }

    #[test]
    fn url_and_qr() {
        let url = otpauth_url("RustRMM", "owner@example.com", "ABCDEF");
        assert!(url.starts_with("otpauth://totp/RustRMM:owner%40example.com?secret=ABCDEF"));
        assert!(qr_svg(&url).expect("qr").contains("<svg"));
    }
}
