import type { LucideIcon } from 'lucide-react'
import { Activity, FolderOpen, FolderTree, MonitorPlay, Radar, RotateCcwClock, ScrollText, ServerCog, SquareTerminal } from 'lucide-react'
import type { OsFamily } from '@/lib/api/types'
import { PERMISSIONS } from '@/lib/permissions'

/** Snapshot tabs: what the agent last reported about the device. */
export const DEVICE_TABS = [
  'overview',
  'monitoring',
  'performance',
  'hardware',
  'software',
  'storage',
  'network',
  'security',
  'users',
  'patches',
  'scripts',
  'policy',
  'secrets',
  'tickets',
  'timeline',
  'notes',
] as const

/** Live tools that talk to the agent (Phases 4 and 8), grouped under one "Remote" tab. */
export const REMOTE_TABS = ['desktop', 'terminal', 'files', 'processes', 'services', 'event-logs', 'registry', 'diagnostics', 'sessions'] as const

export const COCKPIT_TABS = [...DEVICE_TABS, ...REMOTE_TABS] as const

export type CockpitTab = (typeof COCKPIT_TABS)[number]
export type RemoteTab = (typeof REMOTE_TABS)[number]

export const COCKPIT_TAB_LABEL: Record<CockpitTab, string> = {
  overview: 'Overview',
  monitoring: 'Monitoring',
  performance: 'Performance',
  hardware: 'Hardware',
  software: 'Software',
  storage: 'Storage',
  network: 'Network',
  security: 'Security',
  users: 'Users',
  services: 'Services',
  timeline: 'Timeline',
  patches: 'Patches',
  scripts: 'Scripts',
  policy: 'Policy',
  secrets: 'Secrets',
  tickets: 'Tickets',
  notes: 'Notes',
  desktop: 'Desktop',
  terminal: 'Terminal',
  files: 'Files',
  processes: 'Processes',
  'event-logs': 'Event logs',
  registry: 'Registry',
  diagnostics: 'Diagnostics',
  sessions: 'Sessions',
}

export function isRemoteTab(tab: CockpitTab): tab is RemoteTab {
  return (REMOTE_TABS as readonly string[]).includes(tab)
}

export interface RemoteToolMeta {
  icon: LucideIcon
  /** Permission that unlocks the tool; null when anyone who can see the device may open it. */
  permission: string | null
  permissionLabel: string
  /** Whether the tool needs a live agent connection (otherwise it has an offline fallback). */
  live: boolean
  description: string
  /** Platforms the tool exists on; omitted means all. */
  os?: OsFamily[]
}

export const REMOTE_TOOL: Record<RemoteTab, RemoteToolMeta> = {
  desktop: {
    icon: MonitorPlay,
    permission: PERMISSIONS.remoteDesktop,
    permissionLabel: 'Remote desktop',
    live: true,
    description: 'View and control the screen',
  },
  terminal: {
    icon: SquareTerminal,
    permission: PERMISSIONS.remoteShell,
    permissionLabel: 'Remote shell',
    live: true,
    description: 'Interactive, recorded shell on the device',
  },
  files: {
    icon: FolderOpen,
    permission: PERMISSIONS.remoteFiles,
    permissionLabel: 'File browser',
    live: true,
    description: 'Browse, upload and download files',
  },
  processes: {
    icon: Activity,
    permission: PERMISSIONS.remoteSystem,
    permissionLabel: 'System tools',
    live: true,
    description: 'Running processes and resource use',
  },
  services: {
    icon: ServerCog,
    permission: null,
    permissionLabel: 'System tools',
    live: false,
    description: 'Start, stop and restart services',
  },
  'event-logs': {
    icon: ScrollText,
    permission: PERMISSIONS.remoteSystem,
    permissionLabel: 'System tools',
    live: true,
    description: 'Windows event logs, the systemd journal or the unified log',
  },
  registry: {
    icon: FolderTree,
    permission: PERMISSIONS.remoteSystem,
    permissionLabel: 'System tools',
    live: true,
    description: 'Read-only registry browser',
    os: ['windows'],
  },
  diagnostics: {
    icon: Radar,
    permission: PERMISSIONS.remoteSystem,
    permissionLabel: 'System tools',
    live: true,
    description: 'Ping, traceroute, DNS and port tests from the device',
  },
  sessions: {
    icon: RotateCcwClock,
    permission: null,
    permissionLabel: '',
    live: false,
    description: 'Shell and file-transfer history with recordings',
  },
}

/** Remote tabs that exist for a platform (the registry is Windows-only). */
export function remoteTabsFor(os: OsFamily): RemoteTab[] {
  return REMOTE_TABS.filter((tab) => !REMOTE_TOOL[tab].os || REMOTE_TOOL[tab].os.includes(os))
}
