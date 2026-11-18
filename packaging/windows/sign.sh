#!/usr/bin/env sh
# Authenticode-signs a Windows artifact (exe or MSI) in place with osslsigncode and an RFC 3161
# timestamp — the Linux side of `cargo xtask sign --provider pfx` (docs/signing.md).
#
#   packaging/windows/sign.sh <file>
#
# Inputs (BuildKit secrets in the Docker build, or environment variables):
#   /run/secrets/signing_pfx_b64       base64 of the PFX   (or RUSTRMM_SIGN_PFX_BASE64)
#   /run/secrets/signing_pfx_password  its password        (or RUSTRMM_SIGN_PFX_PASSWORD)
#   RUSTRMM_SIGN_TIMESTAMP_URL         default http://timestamp.digicert.com
#
# Without a PFX the file is left unsigned with a warning; signing is never required to build.
set -eu
file="${1:?usage: sign.sh <file>}"

pfx_b64=""
if [ -s /run/secrets/signing_pfx_b64 ]; then
  pfx_b64="$(cat /run/secrets/signing_pfx_b64)"
elif [ -n "${RUSTRMM_SIGN_PFX_BASE64:-}" ]; then
  pfx_b64="$RUSTRMM_SIGN_PFX_BASE64"
fi
if [ -z "$pfx_b64" ]; then
  echo "warning: code signing not configured; $file stays unsigned (docs/signing.md)" >&2
  exit 0
fi
command -v osslsigncode >/dev/null 2>&1 || { echo "osslsigncode is required to sign $file" >&2; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
umask 077
printf '%s' "$pfx_b64" | base64 -d > "$work/cert.pfx"
if [ -s /run/secrets/signing_pfx_password ]; then
  cp /run/secrets/signing_pfx_password "$work/pass"
else
  printf '%s' "${RUSTRMM_SIGN_PFX_PASSWORD:-}" > "$work/pass"
fi

osslsigncode sign -pkcs12 "$work/cert.pfx" -readpass "$work/pass" \
  -h sha256 -n "RustRMM Agent" -ts "${RUSTRMM_SIGN_TIMESTAMP_URL:-http://timestamp.digicert.com}" \
  -in "$file" -out "$work/signed"
mv "$work/signed" "$file"
osslsigncode verify -in "$file" >/dev/null 2>&1 || echo "note: signature added; chain not trusted inside the build container" >&2
echo "signed $file"
