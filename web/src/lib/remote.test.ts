import { describe, expect, it } from 'vitest'
import { ApiError } from './api/errors'
import {
  baseName,
  eventLevel,
  formatRegistryValue,
  isAbsolutePath,
  isDeviceGoneError,
  isIpLiteral,
  isRootPath,
  joinPath,
  normalizePath,
  normalizeRegistryPath,
  parentPath,
  pathSegments,
  registryParent,
  registrySegments,
  remoteAccess,
  shellLabel,
  shellOptions,
  validateFileName,
  validatePort,
  validateTarget,
} from './remote'

describe('remoteAccess', () => {
  const online = { status: 'active' as const, online: true }

  it('allows an online, active device with permission', () => {
    expect(remoteAccess(online, true)).toEqual({ ok: true, block: null, reason: '' })
  })

  it('reports a missing permission before device state', () => {
    const access = remoteAccess({ status: 'active', online: false }, false, { permissionLabel: 'Remote shell' })
    expect(access.block).toBe('permission')
    expect(access.reason).toContain('Remote shell')
  })

  it('explains pending, revoked and offline devices', () => {
    expect(remoteAccess({ status: 'pending', online: false }, true).block).toBe('pending')
    expect(remoteAccess({ status: 'revoked', online: false }, true).block).toBe('revoked')
    expect(remoteAccess({ status: 'quarantined', online: true }, true).block).toBe('inactive')
    expect(remoteAccess({ status: 'active', online: false }, true).block).toBe('offline')
  })

  it('skips the connection check for tools that work offline', () => {
    expect(remoteAccess({ status: 'active', online: false }, true, { requiresOnline: false }).ok).toBe(true)
  })

  it('recognises device-gone errors', () => {
    expect(isDeviceGoneError(new ApiError(409, 'device_offline', 'offline'))).toBe(true)
    expect(isDeviceGoneError(new ApiError(422, 'device_error', 'Access is denied'))).toBe(false)
    expect(isDeviceGoneError(new Error('x'))).toBe(false)
  })
})

describe('Windows paths', () => {
  const w = 'windows' as const

  it('joins with a single backslash', () => {
    expect(joinPath(w, 'C:\\', 'Users')).toBe('C:\\Users')
    expect(joinPath(w, 'C:\\Users', 'Kyle')).toBe('C:\\Users\\Kyle')
    expect(joinPath(w, '', 'C:\\')).toBe('C:\\')
  })

  it('walks up to the drive root and then the drive list', () => {
    expect(parentPath(w, 'C:\\Users\\Kyle\\Desktop')).toBe('C:\\Users\\Kyle')
    expect(parentPath(w, 'C:\\Users')).toBe('C:\\')
    expect(parentPath(w, 'C:\\')).toBe('')
    expect(parentPath(w, '')).toBeNull()
    expect(parentPath(w, '\\\\fs01\\share\\docs')).toBe('\\\\fs01\\share')
    expect(parentPath(w, '\\\\fs01\\share')).toBe('')
  })

  it('normalizes typed paths', () => {
    expect(normalizePath(w, ' c:/users//kyle/ ')).toBe('C:\\users\\kyle')
    expect(normalizePath(w, 'd:')).toBe('D:\\')
    expect(normalizePath(w, 'C:\\')).toBe('C:\\')
    expect(normalizePath(w, '\\\\fs01\\share\\')).toBe('\\\\fs01\\share')
    expect(normalizePath(w, '')).toBe('')
  })

  it('splits breadcrumb segments', () => {
    expect(pathSegments(w, 'C:\\Users\\Kyle')).toEqual([
      { label: 'C:', path: 'C:\\' },
      { label: 'Users', path: 'C:\\Users' },
      { label: 'Kyle', path: 'C:\\Users\\Kyle' },
    ])
    expect(pathSegments(w, 'D:\\')).toEqual([{ label: 'D:', path: 'D:\\' }])
    expect(pathSegments(w, '')).toEqual([])
  })

  it('knows roots, absolute paths and base names', () => {
    expect(isRootPath(w, 'C:\\')).toBe(true)
    expect(isRootPath(w, 'C:\\Windows')).toBe(false)
    expect(isAbsolutePath(w, 'C:\\Windows')).toBe(true)
    expect(isAbsolutePath(w, 'Windows')).toBe(false)
    expect(baseName(w, 'C:\\Users\\Kyle\\report.pdf')).toBe('report.pdf')
    expect(baseName(w, 'C:\\')).toBe('C:')
  })
})

describe('POSIX paths', () => {
  const p = 'posix' as const

  it('joins and walks up to the root', () => {
    expect(joinPath(p, '/', 'etc')).toBe('/etc')
    expect(joinPath(p, '/etc', 'nginx')).toBe('/etc/nginx')
    expect(parentPath(p, '/etc/nginx/sites-enabled')).toBe('/etc/nginx')
    expect(parentPath(p, '/etc')).toBe('/')
    expect(parentPath(p, '/')).toBeNull()
  })

  it('normalizes and splits', () => {
    expect(normalizePath(p, '//var//log/ ')).toBe('/var/log')
    expect(normalizePath(p, '/')).toBe('/')
    expect(pathSegments(p, '/var/log')).toEqual([
      { label: '/', path: '/' },
      { label: 'var', path: '/var' },
      { label: 'log', path: '/var/log' },
    ])
    expect(baseName(p, '/var/log/syslog')).toBe('syslog')
    expect(isAbsolutePath(p, 'var/log')).toBe(false)
  })
})

describe('validateFileName', () => {
  it('rejects names Windows cannot store', () => {
    expect(validateFileName('windows', 'report?.pdf')).not.toBeNull()
    expect(validateFileName('windows', 'CON')).not.toBeNull()
    expect(validateFileName('windows', 'notes.')).not.toBeNull()
    expect(validateFileName('windows', 'Q3 report.xlsx')).toBeNull()
  })

  it('only rejects slashes on POSIX', () => {
    expect(validateFileName('posix', 'a/b')).not.toBeNull()
    expect(validateFileName('posix', 'weird:name?')).toBeNull()
    expect(validateFileName('posix', '..')).not.toBeNull()
    expect(validateFileName('posix', '  ')).not.toBeNull()
  })
})

describe('registry paths', () => {
  it('splits and walks up to the hive list', () => {
    expect(registrySegments('HKLM\\SOFTWARE\\Microsoft')).toEqual([
      { label: 'HKLM', path: 'HKLM' },
      { label: 'SOFTWARE', path: 'HKLM\\SOFTWARE' },
      { label: 'Microsoft', path: 'HKLM\\SOFTWARE\\Microsoft' },
    ])
    expect(registryParent('HKLM\\SOFTWARE')).toBe('HKLM')
    expect(registryParent('HKLM')).toBe('')
    expect(registryParent('')).toBeNull()
  })

  it('accepts long hive names and regedit-style paths', () => {
    expect(normalizeRegistryPath('Computer\\HKEY_LOCAL_MACHINE\\SOFTWARE\\')).toBe('HKLM\\SOFTWARE')
    expect(normalizeRegistryPath('hklm/system')).toBe('HKLM\\system')
    expect(normalizeRegistryPath('  ')).toBe('')
  })
})

describe('formatRegistryValue', () => {
  it('shows DWORDs and QWORDs as hex and decimal', () => {
    expect(formatRegistryValue('REG_DWORD', '1').summary).toBe('0x00000001 (1)')
    expect(formatRegistryValue('REG_DWORD', '0x10').summary).toBe('0x00000010 (16)')
    expect(formatRegistryValue('REG_QWORD', '133700000000000000').summary).toBe('0x01daff710e784000 (133700000000000000)')
    expect(formatRegistryValue('REG_DWORD', 'n/a').summary).toBe('n/a')
  })

  it('splits multi-strings', () => {
    const value = formatRegistryValue('REG_MULTI_SZ', 'one\u0000two\u0000')
    expect(value.summary).toBe('one · two')
    expect(value.full).toBe('one\ntwo')
  })

  it('groups binary data into byte rows', () => {
    const hex = 'A0'.repeat(20)
    const value = formatRegistryValue('REG_BINARY', hex)
    expect(value.summary.split(' ')).toHaveLength(20)
    expect(value.full.split('\n')).toEqual([`0000  ${'a0 '.repeat(15)}a0`, `0010  a0 a0 a0 a0`])
    expect(formatRegistryValue('REG_BINARY', 'aa bb').summary).toBe('aa bb')
    expect(formatRegistryValue('REG_BINARY', '').summary).toContain('zero-length')
  })

  it('marks empty strings as not set', () => {
    expect(formatRegistryValue('REG_SZ', '').summary).toBe('(value not set)')
    expect(formatRegistryValue('REG_EXPAND_SZ', '%SystemRoot%\\system32').summary).toBe('%SystemRoot%\\system32')
  })
})

describe('shells', () => {
  it('offers platform shells with the default first', () => {
    expect(shellOptions('windows').map((option) => option.value)).toEqual(['powershell', 'pwsh', 'cmd'])
    expect(shellOptions('linux')[0].value).toBe('bash')
    expect(shellOptions('macos')[0].value).toBe('zsh')
    expect(shellLabel('pwsh')).toBe('PowerShell 7')
    expect(shellLabel('')).toBe('Default shell')
    expect(shellLabel('fish')).toBe('fish')
  })
})

describe('eventLevel', () => {
  it('maps Windows levels', () => {
    expect(eventLevel(1)).toEqual({ label: 'Critical', tone: 'critical' })
    expect(eventLevel(2).tone).toBe('error')
    expect(eventLevel(3).tone).toBe('warning')
    expect(eventLevel(4)).toEqual({ label: 'Information', tone: 'info' })
    expect(eventLevel(5).label).toBe('Verbose')
  })

  it('treats LogAlways and unknown levels as information', () => {
    expect(eventLevel(0).label).toBe('Information')
    expect(eventLevel(42).label).toBe('Information')
  })
})

describe('diagnostic targets', () => {
  it('accepts host names and IP literals', () => {
    for (const target of ['example.com', 'nwd-dc01', 'nwd-dc01.nwdental.local', '10.12.1.5', '::1', 'fe80::1%eth0', '2606:4700::6810:84e5', '::ffff:192.0.2.1']) {
      expect(validateTarget(target), target).toBeNull()
    }
  })

  it('rejects what the server rejects', () => {
    expect(validateTarget('')).not.toBeNull()
    expect(validateTarget('example .com')).not.toBeNull()
    expect(validateTarget('-c 100 example.com')).not.toBeNull()
    expect(validateTarget('-oProxyCommand')).not.toBeNull()
    expect(validateTarget('exa$mple.com')).not.toBeNull()
  })

  it('recognises IP literals', () => {
    expect(isIpLiteral('192.168.1.1')).toBe(true)
    expect(isIpLiteral('256.1.1.1')).toBe(false)
    expect(isIpLiteral('example.com')).toBe(false)
    expect(isIpLiteral('1::2::3')).toBe(false)
  })

  it('validates ports', () => {
    expect(validatePort('443')).toBeNull()
    expect(validatePort('0')).not.toBeNull()
    expect(validatePort('65536')).not.toBeNull()
    expect(validatePort('80a')).not.toBeNull()
  })
})
