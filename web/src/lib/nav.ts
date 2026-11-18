import type { LinkProps } from '@tanstack/react-router'
import type { LucideIcon } from 'lucide-react'
import {
  Building,
  ChartColumn,
  House,
  MonitorSmartphone,
  Network,
  Package,
  Settings2,
  ShieldCheck,
  Ticket,
  TriangleExclamationPoint,
  Vault,
  Workflow,
} from 'lucide-react'

/** Any route path known to the router (type-checked against the generated route tree). */
export type RoutePath = NonNullable<LinkProps['to']>

export interface NavItem {
  id: string
  label: string
  to: RoutePath
  icon: LucideIcon
  /** Keyboard sequence shown in tooltips and the shortcuts sheet. */
  shortcut?: string
  /** Section arrives in a later delivery phase. */
  phase?: number
  description: string
  /** Shown only to users holding at least one of these permissions. */
  anyPermission?: string[]
}

export const PRIMARY_NAV: NavItem[] = [
  { id: 'home', label: 'Home', to: '/', icon: House, shortcut: 'g h', description: 'Fleet overview' },
  {
    id: 'clients',
    label: 'Clients',
    to: '/clients',
    icon: Building,
    shortcut: 'g c',
    description: 'Client companies and their sites',
  },
  {
    id: 'devices',
    label: 'Devices',
    to: '/devices',
    icon: MonitorSmartphone,
    shortcut: 'g d',
    description: 'Inventory, health and remote tools',
  },
  {
    id: 'alerts',
    label: 'Alerts',
    to: '/alerts',
    icon: TriangleExclamationPoint,
    shortcut: 'g a',
    description: 'Monitoring, triage and maintenance windows',
  },
  {
    id: 'automation',
    label: 'Automation',
    to: '/automation',
    icon: Workflow,
    shortcut: 'g u',
    description: 'Scripts, jobs, groups and policies',
  },
  {
    id: 'patching',
    label: 'Patching',
    to: '/patching',
    icon: ShieldCheck,
    shortcut: 'g p',
    description: 'Updates, approvals and compliance',
  },
  {
    id: 'software',
    label: 'Software',
    to: '/software',
    icon: Package,
    shortcut: 'g w',
    description: 'Fleet software inventory and deployment',
  },
  {
    id: 'tickets',
    label: 'Tickets',
    to: '/tickets',
    icon: Ticket,
    shortcut: 'g t',
    description: 'Helpdesk queue and SLAs',
  },
  {
    id: 'network',
    label: 'Network',
    to: '/network',
    icon: Network,
    shortcut: 'g n',
    description: 'Discovery, SNMP monitoring and traps',
  },
  {
    id: 'secrets',
    label: 'Secrets',
    to: '/secrets',
    icon: Vault,
    shortcut: 'g k',
    description: 'BitLocker keys and local admin passwords',
    anyPermission: ['secrets.reveal', 'secrets.manage'],
  },
  {
    id: 'reports',
    label: 'Reports',
    to: '/reports',
    icon: ChartColumn,
    shortcut: 'g r',
    description: 'Executive summaries, exports and schedules',
    anyPermission: ['reports.view'],
  },
]

export const SETTINGS_NAV: NavItem = {
  id: 'settings',
  label: 'Settings',
  to: '/settings',
  icon: Settings2,
  shortcut: 'g s',
  description: 'Users, security, audit and backups',
}

export const SETTINGS_PAGES: { to: RoutePath; label: string; permission: string | null }[] = [
  { to: '/settings/users', label: 'Users', permission: 'users.view' },
  { to: '/settings/roles', label: 'Roles & permissions', permission: 'users.view' },
  { to: '/settings/security', label: 'My security', permission: null },
  { to: '/settings/custom-fields', label: 'Custom fields', permission: null },
  { to: '/settings/notifications', label: 'Notifications', permission: 'notifications.manage' },
  { to: '/settings/monitoring', label: 'Monitoring', permission: 'settings.view' },
  { to: '/settings/tickets', label: 'Helpdesk', permission: 'tickets.settings' },
  { to: '/settings/backups', label: 'Backups', permission: 'backups.view' },
  { to: '/settings/audit', label: 'Audit log', permission: 'audit.view' },
  { to: '/settings/sso', label: 'Single sign-on', permission: 'settings.manage' },
  { to: '/settings/api-tokens', label: 'API tokens', permission: null },
  { to: '/settings/webhooks', label: 'Webhooks', permission: 'api.manage' },
  { to: '/settings/branding', label: 'Branding', permission: 'settings.view' },
  { to: '/settings/signing', label: 'Code signing', permission: 'settings.manage' },
]

/** Nav items the user may see (sections gated by `anyPermission`). */
export function visibleNav(items: NavItem[], permissions: readonly string[] | undefined): NavItem[] {
  return items.filter((item) => !item.anyPermission || item.anyPermission.some((key) => permissions?.includes(key)))
}

export function isNavActive(item: NavItem, pathname: string) {
  return item.to === '/' ? pathname === '/' : pathname === item.to || pathname.startsWith(`${item.to}/`)
}
