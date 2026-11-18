import { describe, expect, it } from 'vitest'
import type { SoftwarePackageInput } from '@/lib/api/types'
import {
  compactDetection,
  compareVersions,
  describeDetection,
  detectionMatches,
  findPackageFor,
  validateDetection,
  validatePackage,
  wildcardToRegExp,
} from './detection'
import { canUninstall, installerFromName, sourcePlatforms } from './labels'

const base: SoftwarePackageInput = {
  name: '7-Zip',
  publisher: 'Igor Pavlov',
  description: '',
  platforms: ['windows'],
  source: { type: 'winget', id: '7zip.7zip' },
  detection: { type: 'software_name', pattern: '7-Zip*', min_version: '24.0' },
}

describe('detection rule editor validation', () => {
  it('accepts well-formed rules of every type', () => {
    expect(validateDetection({ type: 'software_name', pattern: '7-Zip*', min_version: '24.09' }, ['windows'])).toEqual({})
    expect(validateDetection({ type: 'file', path: 'C:\\Program Files\\7-Zip\\7z.exe' }, ['windows'])).toEqual({})
    expect(validateDetection({ type: 'file', path: '%ProgramFiles%\\7-Zip\\7z.exe', min_version: '24' }, ['windows'])).toEqual({})
    expect(validateDetection({ type: 'file', path: '/usr/bin/7z' }, ['linux'])).toEqual({})
    expect(validateDetection({ type: 'registry', key: 'HKLM\\SOFTWARE\\7-Zip', value: 'Path', equals: 'C:\\Program Files\\7-Zip\\' }, ['windows'])).toEqual({})
    expect(validateDetection({ type: 'none' }, ['linux'])).toEqual({})
  })

  it('requires the key field of each type', () => {
    expect(validateDetection({ type: 'software_name', pattern: ' ' }, ['windows']).pattern).toBeDefined()
    expect(validateDetection({ type: 'file', path: '' }, ['windows']).path).toBeDefined()
    expect(validateDetection({ type: 'registry', key: '' }, ['windows']).key).toBeDefined()
  })

  it('rejects patterns that match everything and non-numeric versions', () => {
    expect(validateDetection({ type: 'software_name', pattern: '**' }, ['windows']).pattern).toMatch(/every application/)
    expect(validateDetection({ type: 'software_name', pattern: 'Chrome*', min_version: 'latest' }, ['windows']).min_version).toBeDefined()
  })

  it('checks paths and registry rules against the platforms', () => {
    expect(validateDetection({ type: 'file', path: 'Program Files\\x.exe' }, ['windows']).path).toMatch(/absolute/)
    expect(validateDetection({ type: 'file', path: 'C:\\x.exe' }, ['macos']).path).toMatch(/Windows path/)
    expect(validateDetection({ type: 'file', path: '/opt/x' }, ['windows']).path).toMatch(/Unix path/)
    expect(validateDetection({ type: 'registry', key: 'SOFTWARE\\x' }, ['windows']).key).toMatch(/hive/)
    expect(validateDetection({ type: 'registry', key: 'HKLM\\SOFTWARE\\x' }, ['linux']).key).toMatch(/only works on Windows/)
    expect(validateDetection({ type: 'registry', key: 'HKLM\\SOFTWARE\\x', equals: '1' }, ['windows']).value).toBeDefined()
  })

  it('describes and compacts rules', () => {
    expect(describeDetection({ type: 'software_name', pattern: '7-Zip*', min_version: '24.0' })).toBe('Software named “7-Zip*” ≥ 24.0')
    expect(compactDetection({ type: 'registry', key: ' HKLM\\A ', value: '', equals: '' })).toEqual({ type: 'registry', key: 'HKLM\\A' })
    expect(compactDetection({ type: 'file', path: '/usr/bin/7z', min_version: ' ' })).toEqual({ type: 'file', path: '/usr/bin/7z' })
  })
})

describe('package validation', () => {
  it('accepts a complete package', () => {
    expect(validatePackage(base)).toEqual({})
  })

  it('checks names, ids, platforms and arguments like the server', () => {
    expect(validatePackage({ ...base, name: '' }).name).toBeDefined()
    expect(validatePackage({ ...base, source: { type: 'winget', id: '--force' } })['source.id']).toMatch(/start with/)
    expect(validatePackage({ ...base, platforms: ['windows', 'linux'] }).platforms).toMatch(/only on windows/)
    expect(validatePackage({ ...base, platforms: [] }).platforms).toBeDefined()
    const file: SoftwarePackageInput = {
      ...base,
      source: { type: 'file', file_id: '', file_name: '', sha256: '', size_bytes: 0, installer: 'msi', install_args: '/qn\n/norestart', uninstall_args: '' },
    }
    const errors = validatePackage(file)
    expect(errors['source.file']).toBeDefined()
    expect(errors['source.install_args']).toBe('Arguments are one line')
  })

  it('prefixes detection problems', () => {
    expect(validatePackage({ ...base, detection: { type: 'software_name', pattern: '' } })['detection.pattern']).toBeDefined()
  })

  it('derives platforms and uninstall support from the source', () => {
    expect(sourcePlatforms({ type: 'brew' })).toEqual(['macos'])
    expect(sourcePlatforms({ type: 'file', installer: 'sh' })).toEqual(['linux', 'macos'])
    expect(installerFromName('7z2501-x64.MSI')).toBe('msi')
    expect(installerFromName('notes.txt')).toBeNull()
    expect(canUninstall({ type: 'file', file_id: 'f', file_name: 'a.exe', sha256: '', size_bytes: 1, installer: 'exe', install_args: '/S', uninstall_args: '' })).toBe(false)
    expect(canUninstall({ type: 'file', file_id: 'f', file_name: 'a.msi', sha256: '', size_bytes: 1, installer: 'msi', install_args: '', uninstall_args: '' })).toBe(true)
  })
})

describe('matching inventory to packages', () => {
  it('matches wildcards case-insensitively and compares versions numerically', () => {
    expect(wildcardToRegExp('7-Zip*').test('7-zip 25.01 (x64)')).toBe(true)
    expect(wildcardToRegExp('Mozilla Firefox (x64 ??-US)').test('Mozilla Firefox (x64 en-US)')).toBe(true)
    expect(wildcardToRegExp('a.b').test('axb')).toBe(false)
    expect(compareVersions('24.09', '24.8')).toBe(1)
    expect(compareVersions('142.0.7444.176', '142.0.7444.176')).toBe(0)
    expect(compareVersions('8.8', '8.8.8')).toBe(-1)
  })

  it('applies the minimum version for detection but not for finding the package', () => {
    const detection = { type: 'software_name' as const, pattern: '7-Zip*', min_version: '26.0' }
    expect(detectionMatches(detection, { name: '7-Zip 25.01 (x64)', version: '25.01' })).toBe(false)
    expect(detectionMatches({ ...detection, min_version: '24.0' }, { name: '7-Zip 25.01 (x64)', version: '25.01' })).toBe(true)
    const packages = [
      { name: 'Firefox', platforms: ['windows' as const], detection: { type: 'software_name' as const, pattern: 'Mozilla Firefox*' } },
      { name: '7-Zip', platforms: ['windows' as const], detection },
      { name: 'VLC media player', platforms: ['windows' as const], detection: { type: 'none' as const } },
    ]
    expect(findPackageFor(packages, { name: '7-Zip 25.01 (x64)' })?.name).toBe('7-Zip')
    expect(findPackageFor(packages, { name: 'VLC media player' })?.name).toBe('VLC media player')
    expect(findPackageFor(packages, { name: 'Mozilla Firefox (x64 en-US)' }, 'linux')).toBeUndefined()
  })
})
