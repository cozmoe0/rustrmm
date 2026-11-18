import { describe, expect, it } from 'vitest'
import type { Client, CommandDiagnostic, Site } from '@/lib/api/types'
import { parseAsciicast } from '@/lib/asciicast'
import { seedDevices } from './devices'
import {
  AgentError,
  canonicalPath,
  eventLogsFor,
  findNode,
  isProtectedPath,
  killProcess,
  parentOf,
  processesFor,
  registryFor,
  runDiagnostic,
  scriptedRecording,
  seedSessionsFor,
  servicesFor,
} from './remote-data'

const CLIENTS = ['Northwind Dental', 'Harbor & Pine Legal', 'Summit Freight', 'Bluebird Bakery Co.', 'Cedar Ridge Veterinary', 'Atlas Architecture', 'Meridian Credit Union', 'Oakline Schools Foundation']
const SITES = [3, 2, 4, 2, 2, 3, 4, 2]
const clients = CLIENTS.map((name, index) => ({ id: `c${index}`, name }) as Client)
const sites = SITES.flatMap((count, clientIndex) =>
  Array.from({ length: count }, (_, siteIndex) => ({ id: `s${clientIndex}-${siteIndex}`, client_id: `c${clientIndex}`, name: `Site ${siteIndex}` }) as Site),
)
const devices = seedDevices(clients, sites)
const byHost = (host: string) => devices.find((device) => device.hostname === host && device.status === 'active')!

describe('mock remote data', () => {
  it('lists processes per OS with the protected PIDs in place', () => {
    const windows = processesFor(byHost('NWD-FRONT-01'))
    expect(windows.some((item) => item.pid === 0)).toBe(true)
    expect(windows.find((item) => item.pid === 4)?.name).toBe('System')
    expect(windows.some((item) => item.name === 'rustrmm-agent.exe')).toBe(true)
    const linux = processesFor(byHost('sf-wms-01'))
    expect(linux.find((item) => item.pid === 1)?.name).toBe('systemd')
    // Sorted by CPU, then memory.
    expect(linux.every((item, index) => index === 0 || linux[index - 1].cpu >= item.cpu)).toBe(true)
  })

  it('ends a process tree', () => {
    const device = byHost('NWD-FRONT-02')
    const before = processesFor(device)
    const parent = before.find((item) => item.name === 'msedge.exe' && before.some((child) => child.parent === item.pid))!
    const terminated = killProcess(device, parent.pid, true)
    expect(terminated).toBeGreaterThan(1)
    expect(processesFor(device)).toHaveLength(before.length - terminated)
  })

  it('shapes services per platform', () => {
    expect(servicesFor(byHost('NWD-FRONT-01')).get('Spooler')?.start_mode).toBe('auto')
    expect(servicesFor(byHost('sf-wms-01')).get('ssh.service')?.load).toBe('loaded')
    expect(servicesFor(byHost('mbp-jsato')).get('com.rustrmm.agent')?.state).toBe('running')
  })

  it('filters event logs by level and rejects unknown channels', () => {
    const device = byHost('NWD-FRONT-01')
    const errors = eventLogsFor(device, 'System', 2, 168, 1000)
    expect(errors.length).toBeGreaterThan(0)
    expect(errors.every((entry) => entry.level >= 1 && entry.level <= 2)).toBe(true)
    expect(eventLogsFor(device, 'Application', 0, 24, 10)).toHaveLength(10)
    expect(() => eventLogsFor(device, 'Nope/Operational', 0, 24, 10)).toThrow(AgentError)
    expect(eventLogsFor(byHost('sf-wms-01'), '', 0, 24, 5)[0].id).toBeNull()
  })

  it('browses the registry case-insensitively and refuses protected hives', () => {
    const device = byHost('NWD-FRONT-01')
    expect(registryFor(device, '').keys.map((key) => key.name)).toEqual(['HKLM', 'HKU', 'HKCR', 'HKCC'])
    const listing = registryFor(device, 'hklm\\software\\microsoft\\windows nt\\currentversion')
    expect(listing.path).toBe('HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion')
    expect(listing.values.find((value) => value.name === 'CurrentBuild')?.type).toBe('REG_SZ')
    expect(() => registryFor(device, 'HKLM\\SAM')).toThrow(/Access is denied/)
    expect(() => registryFor(device, 'HKLM\\Missing')).toThrow(/cannot find/)
  })

  it('models a file system with canonical paths and protected folders', () => {
    const device = byHost('NWD-FRONT-01')
    expect(findNode(device, 'C:\\Users')?.dir).toBe(true)
    expect(canonicalPath(device, 'c:\\users\\public')).toBe('C:\\Users\\Public')
    expect(parentOf(device, 'C:\\Users')).toBe('C:\\')
    expect(parentOf(device, 'C:\\')).toBe('')
    expect(isProtectedPath(device, 'C:\\Windows\\System32')).toBe(true)
    expect(isProtectedPath(device, 'C:\\Users\\Public')).toBe(false)
    const linux = byHost('sf-wms-01')
    expect(findNode(linux, '/etc/hostname')?.dir).toBe(false)
    expect(isProtectedPath(linux, '/opt/rustrmm/bin')).toBe(true)
  })

  it('runs diagnostics with platform output', () => {
    const device = byHost('NWD-FRONT-01')
    const ping = runDiagnostic(device, 'ping', 'example.com').result as CommandDiagnostic
    expect(ping.command).toContain('ping -n 4')
    expect(ping.exit_code).toBe(0)
    expect(runDiagnostic(device, 'dns', 'nothing.invalid').result).toMatchObject({ resolved: false })
  })

  it('seeds session history whose recordings parse as asciicast v2', () => {
    const device = byHost('NWD-DC01')
    const sessions = seedSessionsFor(device, ['Sam Rivera'])
    expect(sessions.some((session) => session.live)).toBe(true)
    for (const session of sessions.filter((item) => item.has_recording)) {
      const cast = parseAsciicast(scriptedRecording(session, device))
      expect(cast.header.width).toBe(session.detail?.cols)
      expect(cast.events.some((event) => event.type === 'r')).toBe(true)
      expect(cast.duration).toBeGreaterThan(10)
    }
  })
})
