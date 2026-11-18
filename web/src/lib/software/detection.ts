/*
 * Library package editing: detection rule defaults and validation, package validation (the server's
 * rules), wildcard matching and version comparison used to match inventory against packages.
 */
import type { DetectionRule, OsFamily, PackageSource, SoftwareItem, SoftwarePackage, SoftwarePackageInput } from '@/lib/api/types'
import { DETECTION_LABEL, SOURCE_META, sourcePlatforms } from './labels'

export const ARGS_MAX = 1000
const VERSION = /^\d+(\.\d+){0,3}$/

/** Field → message; empty when the rule is valid. */
export type FieldErrors = Partial<Record<string, string>>

export function defaultDetection(type: DetectionRule['type'], name = ''): DetectionRule {
  switch (type) {
    case 'software_name':
      return { type, pattern: name ? `${name}*` : '' }
    case 'file':
      return { type, path: '' }
    case 'registry':
      return { type, key: '' }
    case 'none':
      return { type }
  }
}

/**
 * Validates a detection rule for the package's platforms. Versions are numeric (`24`, `24.09`, up to
 * four parts); registry rules only make sense on Windows; a value comparison needs a value name.
 */
export function validateDetection(rule: DetectionRule, platforms: readonly OsFamily[]): FieldErrors {
  const errors: FieldErrors = {}
  if (rule.type === 'software_name') {
    const pattern = rule.pattern.trim()
    if (!pattern) errors.pattern = 'Enter the name as it appears in the software inventory'
    else if (pattern.length > 200) errors.pattern = 'At most 200 characters'
    else if (/^[*?\s]+$/.test(pattern)) errors.pattern = 'The pattern would match every application; add some literal text'
    if (rule.min_version && !VERSION.test(rule.min_version.trim())) errors.min_version = 'Use a numeric version such as 24.09'
  } else if (rule.type === 'file') {
    const path = rule.path.trim()
    if (!path) errors.path = 'Enter the full path of a file the package installs'
    else {
      const windowsPath = /^([a-z]:\\|\\\\|%[a-z_]+%)/i.test(path)
      const unixPath = path.startsWith('/')
      if (!windowsPath && !unixPath) errors.path = 'Use an absolute path (C:\\…, %ProgramFiles%\\… or /…)'
      else if (windowsPath && platforms.length > 0 && !platforms.includes('windows'))
        errors.path = 'This is a Windows path, but the package is not for Windows'
      else if (unixPath && platforms.length > 0 && platforms.every((os) => os === 'windows'))
        errors.path = 'This is a Unix path, but the package is Windows-only'
    }
    if (rule.min_version && !VERSION.test(rule.min_version.trim())) errors.min_version = 'Use a numeric version such as 24.09'
  } else if (rule.type === 'registry') {
    const key = rule.key.trim()
    if (!key) errors.key = 'Enter a registry key'
    else if (!/^(HKLM|HKEY_LOCAL_MACHINE|HKCU|HKEY_CURRENT_USER|HKCR|HKU)\\/i.test(key))
      errors.key = 'Start with a hive such as HKLM\\SOFTWARE\\…'
    if (platforms.length > 0 && !platforms.includes('windows')) errors.key = 'Registry detection only works on Windows'
    if (rule.equals !== undefined && rule.equals !== '' && !rule.value?.trim())
      errors.value = 'Name the value to compare'
  }
  return errors
}

/** "Software named “7-Zip*” ≥ 24.0". */
export function describeDetection(rule: DetectionRule): string {
  switch (rule.type) {
    case 'software_name':
      return `Software named “${rule.pattern}”${rule.min_version ? ` ≥ ${rule.min_version}` : ''}`
    case 'file':
      return `${rule.path}${rule.min_version ? ` ≥ ${rule.min_version}` : ''}`
    case 'registry':
      return `${rule.key}${rule.value ? `\\${rule.value}` : ''}${rule.equals ? ` = ${rule.equals}` : ''}`
    case 'none':
      return DETECTION_LABEL.none
  }
}

/** Removes empty optional fields so the stored rule is minimal. */
export function compactDetection(rule: DetectionRule): DetectionRule {
  if (rule.type === 'software_name') return { type: rule.type, pattern: rule.pattern.trim(), ...(rule.min_version?.trim() ? { min_version: rule.min_version.trim() } : {}) }
  if (rule.type === 'file') return { type: rule.type, path: rule.path.trim(), ...(rule.min_version?.trim() ? { min_version: rule.min_version.trim() } : {}) }
  if (rule.type === 'registry')
    return {
      type: rule.type,
      key: rule.key.trim(),
      ...(rule.value?.trim() ? { value: rule.value.trim() } : {}),
      ...(rule.equals?.trim() ? { equals: rule.equals.trim() } : {}),
    }
  return rule
}

/** Package editor validation: field path → message. */
export function validatePackage(input: SoftwarePackageInput): FieldErrors {
  const errors: FieldErrors = {}
  if (!input.name.trim()) errors.name = 'Enter a name'
  else if (input.name.length > 120) errors.name = 'At most 120 characters'
  const supported = sourcePlatforms(input.source)
  if (input.platforms.length === 0) errors.platforms = 'Choose at least one platform'
  else if (input.platforms.some((os) => !supported.includes(os)))
    errors.platforms = `${SOURCE_META[input.source.type].label} installs only on ${supported.join(', ')}`
  const source = input.source
  if (source.type === 'file') {
    if (!source.file_id) errors['source.file'] = 'Upload an installer'
    for (const key of ['install_args', 'uninstall_args'] as const) {
      if (/[\r\n]/.test(source[key])) errors[`source.${key}`] = 'Arguments are one line'
      else if (source[key].length > ARGS_MAX) errors[`source.${key}`] = `At most ${ARGS_MAX} characters`
    }
  } else {
    const id = source.id.trim()
    if (!id) errors['source.id'] = `Enter the ${SOURCE_META[source.type].idLabel.toLowerCase()}`
    else if (id.startsWith('-')) errors['source.id'] = 'Package IDs may not start with “-”'
    else if (/\s/.test(id)) errors['source.id'] = 'Package IDs contain no spaces'
  }
  for (const [field, message] of Object.entries(validateDetection(input.detection, input.platforms)))
    errors[`detection.${field}`] = message
  return errors
}

/** A `*`/`?` wildcard pattern as a case-insensitive, anchored regular expression. */
export function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.trim().replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`, 'i')
}

/** Numeric, part-by-part comparison ("24.09" > "24.8"); non-numeric parts compare as text. */
export function compareVersions(a: string, b: string): number {
  const left = a.split(/[.\-+_ ]/)
  const right = b.split(/[.\-+_ ]/)
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const x = left[index] ?? '0'
    const y = right[index] ?? '0'
    const nx = Number(x)
    const ny = Number(y)
    if (Number.isFinite(nx) && Number.isFinite(ny)) {
      if (nx !== ny) return nx < ny ? -1 : 1
    } else if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/** Whether a `software_name` detection rule recognises an inventory entry. */
export function detectionMatches(rule: DetectionRule, item: Pick<SoftwareItem, 'name' | 'version'>): boolean {
  if (rule.type !== 'software_name' || !rule.pattern.trim()) return false
  if (!wildcardToRegExp(rule.pattern).test(item.name)) return false
  if (rule.min_version && item.version) return compareVersions(item.version, rule.min_version) >= 0
  return true
}

/**
 * The library package an inventory entry belongs to: the package's `software_name` pattern matches the
 * name (ignoring the minimum version), or the names are equal. Used for "Uninstall" and "Deploy update".
 */
export function findPackageFor<T extends Pick<SoftwarePackage, 'name' | 'detection' | 'platforms'>>(
  packages: readonly T[],
  item: Pick<SoftwareItem, 'name'>,
  os?: OsFamily,
): T | undefined {
  const fits = (pkg: T) => !os || pkg.platforms.includes(os)
  return (
    packages.find((pkg) => fits(pkg) && pkg.detection.type === 'software_name' && wildcardToRegExp(pkg.detection.pattern).test(item.name)) ??
    packages.find((pkg) => fits(pkg) && pkg.name.toLowerCase() === item.name.toLowerCase())
  )
}

/** The source to start a new package with. */
export function defaultSource(type: PackageSource['type']): PackageSource {
  if (type === 'file')
    return { type, file_id: '', file_name: '', sha256: '', size_bytes: 0, installer: 'msi', install_args: '/qn /norestart', uninstall_args: '/qn /norestart' }
  if (type === 'brew') return { type, id: '', cask: false }
  return { type, id: '' } as PackageSource
}
