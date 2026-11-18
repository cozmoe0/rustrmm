/* Severity colours and icon lookups for Phase 6 visuals (kept apart from components for fast refresh). */
import type { LucideIcon } from 'lucide-react'
import {
  Activity,
  BatteryWarning,
  BellRing,
  BrickWallShield,
  CalendarClock,
  Clock,
  Cog,
  Cpu,
  FileSearch,
  FileText,
  Globe,
  HardDrive,
  Hash,
  Info,
  KeyRound,
  Mail,
  MemoryStick,
  MessageSquare,
  OctagonAlert,
  PackageX,
  Plug,
  Power,
  Radar,
  RefreshCw,
  ScrollText,
  ShieldAlert,
  ShieldCheck,
  TerminalSquare,
  TrendingUp,
  TriangleExclamationPoint,
  Users,
  Webhook,
  WifiOff,
} from 'lucide-react'
import type { AlertSeverity, NotificationChannelKind } from '@/lib/api/types'
import type { Tone } from '@/lib/monitoring/labels'

export const SEVERITY_STYLE: Record<
  AlertSeverity,
  { icon: LucideIcon; text: string; soft: string; dot: string; stripe: string; variant: 'critical' | 'warning' | 'info' }
> = {
  critical: {
    icon: OctagonAlert,
    text: 'text-critical',
    soft: 'bg-critical/12 text-critical ring-1 ring-critical/30',
    dot: 'bg-critical',
    stripe: 'bg-critical',
    variant: 'critical',
  },
  warning: {
    icon: TriangleExclamationPoint,
    text: 'text-warning',
    soft: 'bg-warning/14 text-warning ring-1 ring-warning/30',
    dot: 'bg-warning',
    stripe: 'bg-warning',
    variant: 'warning',
  },
  info: {
    icon: Info,
    text: 'text-info',
    soft: 'bg-info/12 text-info ring-1 ring-info/25',
    dot: 'bg-info',
    stripe: 'bg-info',
    variant: 'info',
  },
}

export const TONE_TEXT: Record<Tone, string> = {
  live: 'text-live',
  success: 'text-success',
  warning: 'text-warning',
  critical: 'text-critical',
  info: 'text-info',
  neutral: 'text-muted-foreground',
}

export const CHECK_TYPE_ICON: Record<string, LucideIcon> = {
  cpu: Cpu,
  memory: MemoryStick,
  disk: HardDrive,
  service: Cog,
  process: Activity,
  event_log: ScrollText,
  script: TerminalSquare,
  ping: Radar,
  tcp_port: Plug,
  http: Globe,
  certificate: KeyRound,
  pending_reboot: Power,
  antivirus: ShieldCheck,
  firewall: BrickWallShield,
  uptime: Clock,
  file: FileSearch,
  windows_update: CalendarClock,
  battery: BatteryWarning,
  offline: WifiOff,
  agent_outdated: RefreshCw,
  disk_forecast: TrendingUp,
  security: ShieldAlert,
  patching: PackageX,
}

/** The icon for a check type or server check key (`security.local_admin_added` → `security`). */
export function checkTypeIcon(type: string): LucideIcon {
  return CHECK_TYPE_ICON[type] ?? CHECK_TYPE_ICON[type.split('.')[0]] ?? FileText
}

export const CHANNEL_KIND_ICON: Record<NotificationChannelKind, LucideIcon> = {
  email: Mail,
  slack: Hash,
  teams: Users,
  discord: MessageSquare,
  ntfy: BellRing,
  webhook: Webhook,
}

