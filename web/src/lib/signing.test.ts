import { describe, expect, it } from 'vitest'
import type { SigningFile } from '@/lib/api/types'
import { certificateValidity, commonName, parsePlatform, tamperedFiles } from './signing'

const file = (patch: Partial<SigningFile>): SigningFile => ({
  file: 'rustrmm-agent.exe',
  format: 'pe',
  status: 'signed',
  method: 'authenticode',
  signer: null,
  timestamped: true,
  digest_valid: true,
  detail: null,
  ...patch,
})

describe('signing helpers', () => {
  it('reads platform families from bundle directory names', () => {
    expect(parsePlatform('windows-x86_64')).toEqual({ family: 'windows', label: 'Windows', arch: 'x86_64' })
    expect(parsePlatform('macos-universal')).toEqual({ family: 'macos', label: 'macOS', arch: 'universal' })
    expect(parsePlatform('linux')).toEqual({ family: 'linux', label: 'Linux', arch: null })
    expect(parsePlatform('linux-aarch64')).toEqual({ family: 'linux', label: 'Linux', arch: 'aarch64' })
    expect(parsePlatform('freebsd-amd64')).toEqual({ family: null, label: 'freebsd', arch: 'amd64' })
    expect(parsePlatform('windows-arm64-ec')).toEqual({ family: 'windows', label: 'Windows', arch: 'arm64-ec' })
  })

  it('extracts common names from X.500 subjects', () => {
    expect(commonName('C=US, O=Contoso Ltd, CN=Contoso Ltd')).toBe('Contoso Ltd')
    expect(commonName('CN=Lumen IT Partners LLC, O=Lumen IT Partners LLC')).toBe('Lumen IT Partners LLC')
    expect(commonName('minisign key 0102030405060708')).toBe('minisign key 0102030405060708')
    expect(commonName(null)).toBeNull()
  })

  it('classifies certificate validity', () => {
    const now = new Date('2026-11-18T00:00:00Z').getTime()
    const at = (days: number) => new Date(now + days * 86_400_000).toISOString()
    expect(certificateValidity({ not_before: at(-10), not_after: at(300) }, now)).toBe('valid')
    expect(certificateValidity({ not_before: at(-10), not_after: at(10) }, now)).toBe('expiring')
    expect(certificateValidity({ not_before: at(-400), not_after: at(-1) }, now)).toBe('expired')
    expect(certificateValidity({ not_before: at(2), not_after: at(400) }, now)).toBe('not_yet_valid')
    expect(certificateValidity({ not_before: null, not_after: null }, now)).toBe('unknown')
    expect(certificateValidity(null, now)).toBe('unknown')
  })

  it('flags files whose digest no longer matches or whose signature is invalid', () => {
    const platforms = [
      { platform: 'windows-x86_64', status: 'invalid' as const, files: [file({ digest_valid: false, status: 'invalid' }), file({ file: 'agent.msi', format: 'msi', digest_valid: null })] },
      { platform: 'linux-x86_64', status: 'unsigned' as const, files: [file({ file: 'rustrmm-agent', format: 'elf', status: 'unsigned', method: null, digest_valid: null })] },
    ]
    expect(tamperedFiles({ platforms }).map((entry) => `${entry.platform}/${entry.file.file}`)).toEqual(['windows-x86_64/rustrmm-agent.exe'])
  })
})
