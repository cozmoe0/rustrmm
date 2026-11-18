/*
 * Phase 10 escrow seed: BitLocker recovery keys for encrypted Windows devices (a few still missing, some
 * superseded), LAPS passwords with rotation history where a policy enables LAPS (Northwind Dental, Harbor &
 * Pine Legal and Meridian), reveal history with matching audit entries, and LAPS state with overdue and
 * failed rotations. FileVault and LUKS stay status-only, as on the real agent.
 */
import type { AuditEvent, Client, Site } from '@/lib/api/types'
import type { MockAutomation } from './automation-model'
import { hashString, rng, type MockDevice } from './devices'
import { bitlockerKey, lapsPassword, protectorId, type MockEscrow, type MockEscrowItem, type MockLapsState } from './escrow-state'

const DAY = 86_400_000
const HOUR = 3_600_000
const iso = (ms: number) => new Date(ms).toISOString()

type SeedAudit = Omit<AuditEvent, 'id' | 'hash'>

/** Encrypted devices whose key never reached the server (offline since the protector was added). */
const MISSING_BITLOCKER = ['HPL-LT-PARTNER2', 'SF-DOCK-TAB-03', 'CRV-MOBILE-LT']
/** Devices whose protector was replaced once (the older key is superseded). */
const ROTATED_PROTECTOR = ['NWD-OP1', 'SF-HQ-CFO-LT', 'ATLAS-CAD-07', 'MCU-HO-WS01']
/** Servers with a second, data volume. */
const DATA_VOLUME = ['NWD-FS01', 'HPL-DMS01', 'CRV-SRV-01']
const LAPS_CLIENTS = ['Northwind Dental', 'Harbor & Pine Legal', 'Meridian Credit Union']

export function seedEscrow(input: {
  devices: MockDevice[]
  clients: Client[]
  sites: Site[]
  users: { id: string; name: string }[]
  automation: MockAutomation
  now: number
  id: () => string
}): { escrow: MockEscrow; audit: SeedAudit[] } {
  const { devices, clients, users, automation, now, id } = input
  const r = rng(hashString('phase-10-escrow'))
  const escrow: MockEscrow = { items: [], laps: {} }
  const audit: SeedAudit[] = []
  const client = (prefix: string) => clients.find((item) => item.name.startsWith(prefix))!
  const user = (name: string) => users.find((item) => item.name === name) ?? users[0]

  // ------------------------------------------------------------ policies
  const meridian = automation.policies.find((policy) => policy.name === 'Meridian compliance')
  if (meridian) {
    meridian.document = { ...meridian.document, escrow: { laps: { enabled: true, account: 'it-admin', rotate_days: 14, rotate_after_reveal_hours: 12 } } }
    meridian.version += 1
  }
  automation.policies.push({
    id: id(),
    name: 'Local admin rotation',
    description: 'LAPS-style rotation of the it-admin account: 20-character passwords, monthly, and 24 hours after anyone reveals one.',
    version: 3,
    document: {
      escrow: {
        laps: { enabled: true, account: 'it-admin', create_if_missing: true, length: 20, complexity: 'full', rotate_days: 30, rotate_after_reveal_hours: 24 },
      },
    },
    assignments: [
      { id: id(), target_type: 'client', target_id: client('Northwind').id, priority: 0 },
      { id: id(), target_type: 'client', target_id: client('Harbor').id, priority: 0 },
    ],
    updated_at: iso(now - 18 * DAY),
    updated_by_name: 'Avery Chen',
  })

  const push = (device: MockDevice | null, item: Omit<MockEscrowItem, 'id' | 'device_id' | 'hostname' | 'client_id' | 'client_name' | 'site_id' | 'reveals' | 'reveal_count' | 'last_revealed_at'>, fallback?: { hostname: string; client: Client; siteId: string | null }) => {
    const full: MockEscrowItem = {
      id: id(),
      device_id: device?.id ?? null,
      hostname: device?.hostname ?? fallback!.hostname,
      client_id: device?.client_id ?? fallback!.client.id,
      client_name: device?.client_name ?? fallback!.client.name,
      site_id: device?.site_id ?? fallback?.siteId ?? null,
      reveals: [],
      reveal_count: 0,
      last_revealed_at: null,
      ...item,
    }
    escrow.items.push(full)
    return full
  }

  const active = devices.filter((device) => device.status === 'active')

  // ------------------------------------------------------------ BitLocker
  for (const device of active) {
    if (device.os_family !== 'windows' || !device.sim.encrypted || MISSING_BITLOCKER.includes(device.hostname)) continue
    const enrolled = new Date(device.enrolled_at).getTime()
    const volumes = DATA_VOLUME.includes(device.hostname) ? ['C:', 'D:'] : ['C:']
    for (const volume of volumes) {
      const rotated = volume === 'C:' && ROTATED_PROTECTOR.includes(device.hostname)
      const captured = rotated ? now - r.between(8, 30) * DAY - r.between(0, 20) * HOUR : Math.max(enrolled + HOUR, now - r.between(40, 180) * DAY)
      if (rotated) {
        const old = Math.max(enrolled + HOUR, captured - r.between(60, 200) * DAY)
        const pid = protectorId(r.hex)
        push(device, {
          kind: 'bitlocker',
          identifier: pid,
          label: `${volume} recovery key`,
          metadata: { volume, key_protector_id: pid },
          captured_at: iso(old),
          superseded_at: iso(captured),
          secret: bitlockerKey(r.next),
        })
      }
      const pid = protectorId(r.hex)
      push(device, {
        kind: 'bitlocker',
        identifier: pid,
        label: `${volume} recovery key`,
        metadata: { volume, key_protector_id: pid },
        captured_at: iso(captured),
        superseded_at: null,
        secret: bitlockerKey(r.next),
      })
    }
  }
  // A key kept after its device was deleted (the reception PC was replaced last spring).
  {
    const northwind = client('Northwind')
    const site = input.sites.find((item) => item.client_id === northwind.id) ?? null
    const pid = protectorId(r.hex)
    push(
      null,
      { kind: 'bitlocker', identifier: pid, label: 'C: recovery key', metadata: { volume: 'C:', key_protector_id: pid }, captured_at: iso(now - 214 * DAY), superseded_at: null, secret: bitlockerKey(r.next) },
      { hostname: 'NWD-RECEPT-OLD', client: northwind, siteId: site?.id ?? null },
    )
  }

  // ------------------------------------------------------------ LAPS
  const lapsClients = new Set(LAPS_CLIENTS.map((name) => clients.find((item) => item.name === name)?.id))
  const OVERDUE: Record<string, number> = { 'NWD-OP2': 33, 'HPL-LT-PARTNER2': 37, 'MCU-LV-TELLER1': 17 }
  for (const device of active) {
    if (!lapsClients.has(device.client_id)) continue
    const rotateDays = device.client_name.startsWith('Meridian') ? 14 : 30
    const enrolled = new Date(device.enrolled_at).getTime()
    const lastRotated = now - (OVERDUE[device.hostname] ?? r.between(1, rotateDays - 2)) * DAY - r.between(0, 20) * HOUR
    const history = r.between(1, 3)
    const account = 'it-admin'
    let captured = lastRotated
    const chain: number[] = [captured]
    for (let step = 0; step < history; step += 1) {
      captured -= rotateDays * DAY + r.between(-6, 6) * HOUR
      if (captured < enrolled) break
      chain.push(captured)
    }
    chain.reverse()
    chain.forEach((at, index) => {
      push(device, {
        kind: 'laps',
        identifier: account,
        label: `${account} password`,
        metadata: { account },
        captured_at: iso(at),
        superseded_at: index < chain.length - 1 ? iso(chain[index + 1]) : null,
        secret: lapsPassword(r.next),
      })
    })
    const state: MockLapsState = {
      device_id: device.id,
      account,
      last_rotated_at: iso(lastRotated),
      next_rotation_at: iso(lastRotated + rotateDays * DAY),
      last_error: null,
      pending_cmd_id: null,
      pending_since: null,
    }
    if (device.hostname === 'MCU-LV-TELLER1') {
      state.pending_cmd_id = id()
      state.pending_since = iso(now - 3 * DAY)
      state.last_error = 'No result from the agent within 15 minutes; retrying'
    }
    if (device.hostname === 'HPL-ANX-SCAN01') state.last_error = 'Could not add it-admin to Administrators: access denied (5)'
    escrow.laps[device.id] = state
  }

  // ------------------------------------------------------------ reveals (with audit)
  const reveal = (hostname: string, kind: 'bitlocker' | 'laps', which: 'current' | 'superseded', entries: { by: string; daysAgo: number; reason: string }[]) => {
    const item = escrow.items.find((candidate) => candidate.hostname === hostname && candidate.kind === kind && (which === 'current' ? !candidate.superseded_at : Boolean(candidate.superseded_at)))
    if (!item) return
    for (const entry of entries) {
      const at = now - entry.daysAgo * DAY - r.between(1, 9) * HOUR
      const actor = user(entry.by)
      item.reveals.push({ user_name: actor.name, reason: entry.reason, at: iso(at) })
      audit.push({
        at: iso(at),
        actor: { type: 'user', id: actor.id, name: actor.name },
        action: 'secret.revealed',
        target: { type: 'escrow_item', id: item.id, name: `${item.hostname} · ${item.label}` },
        client_id: item.client_id,
        site_id: item.site_id,
        ip: '10.20.0.31',
        user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0 Safari/537.36',
        details: { reason: entry.reason, kind: item.kind, identifier: item.identifier, device_id: item.device_id, hostname: item.hostname },
      })
    }
    item.reveals.sort((a, b) => a.at.localeCompare(b.at))
    item.reveal_count = item.reveals.length
    item.last_revealed_at = item.reveals.at(-1)?.at ?? null
  }
  reveal('NWD-OP1', 'bitlocker', 'current', [{ by: 'Sam Rivera', daysAgo: 6, reason: 'BIOS update on OP1 put it into BitLocker recovery at 7:40, patient waiting' }])
  reveal('SF-HQ-CFO-LT', 'bitlocker', 'superseded', [
    { by: 'Riley Brooks', daysAgo: 52, reason: 'CFO laptop motherboard swap (Dell case 194-883-210), recovery prompt on boot' },
    { by: 'Riley Brooks', daysAgo: 51, reason: 'Second recovery prompt after TPM clear, same repair' },
  ])
  reveal('NWD-FRONT-01', 'laps', 'current', [{ by: 'Morgan Lee', daysAgo: 0.6, reason: 'Imaging bridge install at the front desk needs a local admin' }])
  reveal('MCU-HO-WS02', 'laps', 'superseded', [{ by: 'Jordan Patel', daysAgo: 9, reason: 'Teller receipt printer driver install, rotated after reveal' }])
  reveal('HPL-DMS01', 'bitlocker', 'current', [{ by: 'Avery Chen', daysAgo: 23, reason: 'DR test: verifying the data volume key opens the restored VHDX' }])

  // ------------------------------------------------------------ capture audit (agent actor)
  for (const item of escrow.items.filter((candidate) => !candidate.superseded_at && candidate.device_id).slice(-12)) {
    audit.push({
      at: item.captured_at,
      actor: { type: 'agent', id: item.device_id, name: item.hostname },
      action: 'secret.escrowed',
      target: { type: 'escrow_item', id: item.id, name: `${item.hostname} · ${item.label}` },
      client_id: item.client_id,
      site_id: item.site_id,
      ip: null,
      user_agent: null,
      details: { kind: item.kind, identifier: item.identifier, device_id: item.device_id },
    })
  }
  return { escrow, audit }
}
