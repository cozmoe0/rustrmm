import type { Device } from '@/lib/api/types'

export function deviceTone(device: Pick<Device, 'status' | 'online'>) {
  if (device.status === 'pending') return 'info' as const
  if (device.status === 'revoked') return 'neutral' as const
  if (device.status === 'quarantined') return 'warning' as const
  return device.online ? ('live' as const) : ('offline' as const)
}

export function deviceStatusLabel(device: Pick<Device, 'status' | 'online'>) {
  if (device.status === 'pending') return 'Awaiting approval'
  if (device.status === 'revoked') return 'Revoked'
  if (device.status === 'quarantined') return 'Quarantined'
  return device.online ? 'Online' : 'Offline'
}
