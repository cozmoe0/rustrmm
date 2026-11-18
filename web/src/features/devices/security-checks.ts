import type { DeviceDetail, SecurityInventory } from '@/lib/api/types'

/** Pass/fail posture rows derived from the security inventory section. */
export function securityChecks(device: Pick<DeviceDetail, 'os_family'>, security: SecurityInventory | undefined, pendingReboot?: boolean) {
  if (!security) return []
  const av = security.antivirus?.[0]
  const checks: { key: string; label: string; ok: boolean | null | undefined; detail?: string; warn?: boolean }[] = []
  if (device.os_family !== 'linux') {
    checks.push({
      key: 'av',
      label: av?.name ?? 'Antivirus',
      ok: av ? av.enabled && av.up_to_date !== false : false,
      detail: !av ? 'None detected' : !av.enabled ? 'Disabled' : av.up_to_date === false ? 'Out of date' : 'Active',
    })
  }
  checks.push({
    key: 'firewall',
    label: 'Firewall',
    ok: security.firewall?.enabled,
    detail: security.firewall?.enabled == null ? 'Unknown' : security.firewall.enabled ? 'On' : 'Off',
  })
  const method = security.encryption?.method
  checks.push({
    key: 'encryption',
    label: method === 'bitlocker' ? 'BitLocker' : method === 'filevault' ? 'FileVault' : method === 'luks' ? 'Disk encryption (LUKS)' : 'Disk encryption',
    ok: security.encryption?.system_volume_encrypted,
    detail: security.encryption?.system_volume_encrypted ? 'System volume encrypted' : 'Not encrypted',
  })
  if (security.secure_boot !== undefined) checks.push({ key: 'secureboot', label: 'Secure Boot', ok: security.secure_boot, warn: true })
  if (security.uac_enabled !== undefined) checks.push({ key: 'uac', label: 'User Account Control', ok: security.uac_enabled, warn: true })
  if (security.smb1_enabled !== undefined)
    checks.push({ key: 'smb1', label: 'SMBv1 disabled', ok: security.smb1_enabled === null ? null : !security.smb1_enabled, warn: true })
  if (security.autologon_enabled !== undefined)
    checks.push({ key: 'autologon', label: 'Automatic logon disabled', ok: security.autologon_enabled === null ? null : !security.autologon_enabled, warn: true })
  if (security.gatekeeper !== undefined) checks.push({ key: 'gatekeeper', label: 'Gatekeeper', ok: security.gatekeeper, warn: true })
  if (security.sip !== undefined) checks.push({ key: 'sip', label: 'System Integrity Protection', ok: security.sip })
  if (security.selinux !== undefined && security.selinux !== null)
    checks.push({ key: 'selinux', label: 'SELinux', ok: security.selinux === 'enforcing', detail: security.selinux, warn: true })
  if (security.apparmor !== undefined && security.selinux == null) checks.push({ key: 'apparmor', label: 'AppArmor', ok: security.apparmor, warn: true })
  if (security.ssh_root_login !== undefined)
    checks.push({ key: 'sshroot', label: 'SSH root login disabled', ok: security.ssh_root_login === null ? null : !security.ssh_root_login, warn: true })
  if (pendingReboot !== undefined) checks.push({ key: 'reboot', label: 'No restart pending', ok: !pendingReboot, warn: true })
  return checks
}
