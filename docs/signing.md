# Code signing

RustRMM works without code signing: agents trust their updates through the server's Ed25519
release key, whatever Authenticode or Apple say. Signing the agent binaries still matters in
practice:

- **Windows**: SmartScreen and Defender treat unsigned new executables with suspicion (the ASR rule
  "Block executable files unless they meet a prevalence, age, or trusted list criterion" blocks them
  outright), and an MSI signed by your organisation is easier to approve in Group Policy and Intune.
- **macOS**: Gatekeeper refuses unsigned or un-notarized binaries that arrive with a quarantine flag,
  and TCC grants (Screen Recording, Accessibility) only survive updates when the signing identity
  stays the same.
- **Linux**: a detached minisign signature lets you verify a downloaded binary before installing it.

This guide covers every supported option. Nothing here is required to build: with no
configuration, `cargo xtask dist` prints a warning and produces unsigned artifacts.

## How it fits together

```text
cargo xtask dist
  ├─ build rustrmm-agent.exe ──► sign (Authenticode + RFC 3161 timestamp)
  ├─ wixl packs the signed exe into RustRMMAgent-x64.msi ──► sign the MSI last
  ├─ build Linux agents ──► minisign (optional, <file>.minisig)
  └─ write manifest.json (hashes of the signed files)

cargo xtask sign [paths…]          sign files or a bundle directory afterwards
                                   (refreshes manifest.json; MSIs: see below)
```

The release Docker build signs the same way inside the `bundle` stage with `osslsigncode`
(`packaging/windows/sign.sh`), and the release workflow signs the macOS agent on a macOS runner.

Configuration comes from `signing.toml` in the repository root (git-ignored; start from
`signing.toml.example`) or from `RUSTRMM_SIGN_*` environment variables, which override the file:

| Variable | Meaning |
|---|---|
| `RUSTRMM_SIGN_PROVIDER` | `none`, `pfx`, `pkcs11`, `azure`, `apple-devid`, `apple-selfsigned` |
| `RUSTRMM_SIGN_TIMESTAMP_URL` | RFC 3161 server (default `http://timestamp.digicert.com`; Azure: `http://timestamp.acs.microsoft.com`) |
| `RUSTRMM_SIGN_WINDOWS_TOOL` | `osslsigncode` (default) or `signtool` |
| `RUSTRMM_SIGN_DESCRIPTION` | Program name shown in UAC prompts |
| `RUSTRMM_SIGN_PFX_PATH` / `RUSTRMM_SIGN_PFX_BASE64` | PFX file, or its base64 (CI secret) |
| `RUSTRMM_SIGN_PFX_PASSWORD` | PFX password |
| `RUSTRMM_SIGN_PKCS11_MODULE`, `_CERT`, `_KEY`, `_PIN`, `_THUMBPRINT` | PKCS#11 token settings |
| `RUSTRMM_SIGN_AZURE_DLIB`, `RUSTRMM_SIGN_AZURE_METADATA` | Azure Trusted Signing |
| `RUSTRMM_SIGN_APPLE_IDENTITY`, `RUSTRMM_SIGN_APPLE_NOTARY_PROFILE` | Apple signing identity, notarytool profile |
| `RUSTRMM_SIGN_MINISIGN_KEY`, `RUSTRMM_SIGN_MINISIGN_PASSWORD` | minisign secret key and its password |

Passwords and PINs are never read from `signing.toml`; name the environment variable instead
(`password_env`, `pin_env`). `osslsigncode` receives secrets through a temporary file
(`-readpass`) so they do not appear in process listings; `signtool` only accepts a password on its
command line, so prefer a PKCS#11 token or Azure Trusted Signing on shared build machines.

Useful flags:

```bash
cargo xtask dist --sign-provider pfx          # override the provider for this build
cargo xtask dist --require-signing            # fail (instead of skipping) when tools or inputs are missing
cargo xtask sign --provider pfx dist/agents   # sign an existing bundle
cargo xtask sign path/to/rustrmm-agent.exe    # sign one file
```

A configured provider whose tool is missing (or whose PFX path does not exist) skips with a
warning unless `--require`/`--require-signing` is given. A signing tool that runs and fails is
always an error.

> **MSI order.** An MSI embeds the exe in a cabinet. Signing an existing MSI does not sign the exe
> inside it, so `cargo xtask sign` warns when it signs a bundle that already contains an MSI. Use
> `cargo xtask dist` with signing configured: it signs the exe *before* wixl packs it and the MSI
> after, as Windows Installer expects.

After the server imports a bundle, **Settings → Code signing** (`GET /api/v1/settings/signing-status`)
shows per platform whether each file is signed, the signer's subject, issuer, serial number and
SHA-1 thumbprint, whether a timestamp is present and (for the exe) whether the Authenticode digest
still matches the file.

---

## 1. A self-signed test certificate (labs only)

Self-signed certificates are useful to test the pipeline and Group Policy deployment in a lab. They
give no SmartScreen reputation and must be trusted explicitly on each machine.

**Create it (PowerShell, as an administrator on a lab machine):**

```powershell
$cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject "CN=RustRMM Lab Code Signing" `
  -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 -CertStoreLocation Cert:\CurrentUser\My `
  -NotAfter (Get-Date).AddYears(2)
$password = Read-Host -AsSecureString "PFX password"
Export-PfxCertificate -Cert $cert -FilePath C:\secrets\rustrmm-lab.pfx -Password $password
Export-Certificate -Cert $cert -FilePath C:\secrets\rustrmm-lab.cer
```

Or with OpenSSL on Linux:

```bash
openssl req -x509 -newkey rsa:3072 -sha256 -days 730 -nodes \
  -subj "/CN=RustRMM Lab Code Signing" -addext "extendedKeyUsage=codeSigning" \
  -keyout lab.key -out lab.crt
openssl pkcs12 -export -inkey lab.key -in lab.crt -out rustrmm-lab.pfx
```

**Configure** (`signing.toml`):

```toml
provider = "pfx"
[pfx]
path = "C:/secrets/rustrmm-lab.pfx"
password_env = "RUSTRMM_SIGN_PFX_PASSWORD"
```

```powershell
$env:RUSTRMM_SIGN_PFX_PASSWORD = "…"
cargo xtask dist
```

`osslsigncode` is the default tool (Windows builds: `winget install osslsigncode` or use WSL;
Linux: `apt install osslsigncode`). To use the Windows SDK's signtool instead set
`[windows] tool = "signtool"`.

**Trust it in the lab:** import `rustrmm-lab.cer` into *Trusted Root Certification Authorities*
and *Trusted Publishers* (Group Policy: Computer Configuration → Policies → Windows Settings →
Security Settings → Public Key Policies). Never do this in production.

## 2. A commercial OV or EV certificate

Since June 2023 publicly trusted code-signing certificates (OV and EV) are issued only on hardware:
a USB token, an HSM, or a cloud signing service. Practical choices:

- **Token (YubiKey, SafeNet eToken):** see [PKCS#11 tokens](#4-pkcs11-tokens-and-hsms).
- **Cloud key (DigiCert KeyLocker, SSL.com eSigner, GlobalSign Atlas):** these ship a PKCS#11
  module or a signtool plug-in; use the PKCS#11 provider with their module, or `signtool` with
  the certificate thumbprint.
- **Azure Trusted Signing:** see the next section; usually the cheapest option for organisations
  that can pass Microsoft's identity validation.

EV certificates used to give instant SmartScreen reputation; today OV and EV both build reputation
over time, so sign every release with the same certificate.

## 3. Azure Trusted Signing (Artifact Signing)

1. In the Azure portal create a **Trusted Signing account** and a **certificate profile**
   (Public Trust), and complete identity validation.
2. Give the build identity the role **Trusted Signing Certificate Profile Signer** on the account.
3. On the Windows build machine install the **Trusted Signing Client Tools** (they contain
   `Azure.CodeSigning.Dlib.dll`) and the Windows SDK (`signtool.exe`).
4. Write the metadata file:

   ```json
   {
     "Endpoint": "https://weu.codesigning.azure.net",
     "CodeSigningAccountName": "contoso-signing",
     "CertificateProfileName": "rustrmm-agent"
   }
   ```

5. Authenticate the way `DefaultAzureCredential` expects (environment variables `AZURE_TENANT_ID`,
   `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, a managed identity, or `az login`).
6. Configure:

   ```toml
   provider = "azure"
   [azure]
   dlib = "C:/tools/Microsoft.Trusted.Signing.Client/bin/x64/Azure.CodeSigning.Dlib.dll"
   metadata = "C:/secrets/trusted-signing-metadata.json"
   ```

The timestamp server defaults to `http://timestamp.acs.microsoft.com`. Azure Trusted Signing
certificates are short-lived (days), which is why the RFC 3161 timestamp is essential: it keeps the
signature valid after the certificate expires.

## 4. PKCS#11 tokens and HSMs

**osslsigncode (Linux, macOS, Windows):** install the token's PKCS#11 module (OpenSC for YubiKey
PIV and most smart cards, the vendor's library for SafeNet/Thales), export the certificate chain
to PEM, and find the key's PKCS#11 URI (`p11tool --list-privkeys --login` or
`pkcs11-tool --list-objects`).

```toml
provider = "pkcs11"
[pkcs11]
module = "/usr/lib/x86_64-linux-gnu/opensc-pkcs11.so"
certificate = "/secrets/codesign-chain.pem"
key = "pkcs11:token=CodeSigning;object=codesign;type=private"
pin_env = "RUSTRMM_SIGN_PKCS11_PIN"
# engine = "/usr/lib/x86_64-linux-gnu/engines-1.1/pkcs11.so"   # only for osslsigncode built on OpenSSL 1.x
```

**signtool (Windows):** with the vendor's minidriver installed the token's certificate appears in
the user's certificate store. Use its thumbprint:

```toml
provider = "pkcs11"
[windows]
tool = "signtool"
[pkcs11]
thumbprint = "0123456789ABCDEF0123456789ABCDEF01234567"
```

The token prompts for its PIN (or uses the vendor's single-logon setting). EV tokens normally need
a PIN for every signature, so build interactively or use a cloud key for unattended releases.

## 5. Apple: Developer ID and notarization

Requirements: an Apple Developer Program membership, a Mac (or the release workflow's macOS
runner) with Xcode command-line tools.

1. In Xcode → Settings → Accounts (or developer.apple.com → Certificates) create a
   **Developer ID Application** certificate; it lands in your login keychain.
2. Create an **App Store Connect API key** (Users and Access → Integrations) with the Developer
   role and store notarization credentials once:

   ```bash
   xcrun notarytool store-credentials rustrmm-notary \
     --key AuthKey_ABC123.p8 --key-id ABC123 --issuer 01234567-89ab-cdef-0123-456789abcdef
   ```

3. Configure and sign:

   ```toml
   provider = "apple-devid"
   [apple]
   identity = "Developer ID Application: Example Ltd (TEAMID1234)"
   notary_profile = "rustrmm-notary"
   ```

   ```bash
   cargo xtask sign dist/agents/macos-universal/rustrmm-agent
   ```

`xtask` signs with the hardened runtime and a secure timestamp (both required for notarization),
zips the binary, submits it with `notarytool submit --wait` and reports the outcome. A bare
Mach-O binary cannot have its ticket stapled; Gatekeeper fetches the ticket online the first time.

**In CI** the release workflow imports the certificate into a temporary keychain from
`APPLE_CERTIFICATE_P12_BASE64` / `APPLE_CERTIFICATE_PASSWORD`, stores the notary profile from
`APPLE_NOTARY_KEY_BASE64` / `APPLE_NOTARY_KEY_ID` / `APPLE_NOTARY_ISSUER`, and runs
`cargo xtask sign --require` with `RUSTRMM_SIGN_APPLE_IDENTITY`. Without these secrets the macOS agent is
published unsigned with a warning.

### A stable self-signed identity (no Apple account)

macOS ties TCC permissions (Screen Recording for remote desktop) to the code signature. An
unsigned binary loses them on every update; a binary signed with the *same* self-signed identity
keeps them. To create one: Keychain Access → Certificate Assistant → Create a Certificate…,
name "RustRMM Agent (self-signed)", identity type *Self-Signed Root*, certificate type *Code
Signing*. Then:

```toml
provider = "apple-selfsigned"
[apple]
identity = "RustRMM Agent (self-signed)"
```

Keep the certificate and its private key backed up: signing a later release with a new identity
resets the users' TCC grants. Gatekeeper still treats such binaries as unidentified, so distribute
them through a channel that does not set the quarantine flag (the RustRMM installer script, MDM).

## 6. Linux: minisign

minisign signatures are optional and independent of the provider: whenever `[minisign]` is
configured, every Linux agent gets a `<file>.minisig` next to it (included in the bundle manifest).

```bash
minisign -G -p rustrmm.pub -s rustrmm.key        # once; keep rustrmm.key offline or in a secret store
```

```toml
[minisign]
secret_key = "/secrets/rustrmm.key"
password_env = "RUSTRMM_SIGN_MINISIGN_PASSWORD"   # omit for a key created with -W (no password)
trusted_comment = "RustRMM agent"
```

Publish `rustrmm.pub` (for example on your intranet) and verify downloads with:

```bash
minisign -Vm rustrmm-agent -p rustrmm.pub
```

## Verifying what shipped

- Console: **Settings → Code signing** after the bundle is imported.
- Windows: `Get-AuthenticodeSignature .\rustrmm-agent.exe | Format-List` or
  `signtool verify /pa /v RustRMMAgent-x64.msi`; Linux: `osslsigncode verify -in rustrmm-agent.exe`.
- macOS: `codesign -dvv rustrmm-agent` and `spctl --assess --type execute -vv rustrmm-agent`.
- Linux: `minisign -Vm rustrmm-agent -p rustrmm.pub`.
