/*
 * Settings → Code signing helpers: platform names from the bundle directory, X.500 common names,
 * and certificate validity as the screen shows it.
 */
import type { OsFamily, SigningFile, SigningStatus } from '@/lib/api/types'

const DAY = 86_400_000

/**
 * Splits a bundle platform on the first `-` into OS and architecture: `windows-x86_64` →
 * `{ family: 'windows', label: 'Windows', arch: 'x86_64' }`. Unknown operating systems stay
 * generic (`family: null`, the raw OS part as label).
 */
export function parsePlatform(platform: string): { family: OsFamily | null; label: string; arch: string | null } {
  const dash = platform.indexOf('-')
  const os = (dash === -1 ? platform : platform.slice(0, dash)).trim()
  const arch = dash === -1 ? null : platform.slice(dash + 1).trim() || null
  const key = os.toLowerCase()
  const family: OsFamily | null = key === 'windows' || key === 'macos' || key === 'linux' ? key : null
  const label = family === 'windows' ? 'Windows' : family === 'macos' ? 'macOS' : family === 'linux' ? 'Linux' : os || platform
  return { family, label, arch }
}

/** The CN of an X.500 name (`C=US, O=Contoso, CN=Contoso Ltd` → `Contoso Ltd`); other strings as-is. */
export function commonName(name: string | null | undefined): string | null {
  if (!name) return null
  const match = /(?:^|[,/]\s*)CN=([^,/]+)/.exec(name)
  return match ? match[1].trim() : name
}

export type ValidityState = 'valid' | 'expiring' | 'expired' | 'not_yet_valid' | 'unknown'

/** Where a certificate stands today (expiring = within 30 days). */
export function certificateValidity(signer: Pick<NonNullable<SigningFile['signer']>, 'not_before' | 'not_after'> | null, now = Date.now()): ValidityState {
  if (!signer || (!signer.not_before && !signer.not_after)) return 'unknown'
  if (signer.not_before && new Date(signer.not_before).getTime() > now) return 'not_yet_valid'
  if (signer.not_after) {
    const end = new Date(signer.not_after).getTime()
    if (end < now) return 'expired'
    if (end - now < 30 * DAY) return 'expiring'
  }
  return 'valid'
}

/** Files whose Authenticode digest no longer matches (modified after signing). */
export function tamperedFiles(status: Pick<SigningStatus, 'platforms'>): { platform: string; file: SigningFile }[] {
  return status.platforms.flatMap((platform) => platform.files.filter((file) => file.digest_valid === false || file.status === 'invalid').map((file) => ({ platform: platform.platform, file })))
}

export const FORMAT_LABEL: Record<SigningFile['format'], string> = { pe: 'PE', msi: 'MSI', macho: 'Mach-O', elf: 'ELF', other: 'File' }

export const METHOD_LABEL: Record<NonNullable<SigningFile['method']>, string> = {
  authenticode: 'Authenticode',
  apple: 'Apple Developer ID',
  adhoc: 'Ad-hoc (no identity)',
  minisign: 'minisign',
}
