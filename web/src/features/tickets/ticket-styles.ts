/* Colours and icon lookups for Phase 9 visuals (kept apart from components for fast refresh). */
import type { LucideIcon } from 'lucide-react'
import { Bot, Bug, Code, GitPullRequestArrow, Inbox, LifeBuoy, Mail, MonitorSmartphone, OctagonAlert, TriangleExclamationPoint, Wrench } from 'lucide-react'
import type { TicketPriority, TicketSource, TicketStatus, TicketType } from '@/lib/api/types'
import type { SlaTone } from '@/lib/tickets/sla'

export const STATUS_STYLE: Record<TicketStatus, { dot: string; text: string; soft: string }> = {
  new: { dot: 'bg-info', text: 'text-info', soft: 'bg-info/12 text-info ring-info/25' },
  open: { dot: 'bg-primary', text: 'text-primary', soft: 'bg-primary/12 text-primary ring-primary/25' },
  pending: { dot: 'bg-warning', text: 'text-warning', soft: 'bg-warning/14 text-warning ring-warning/30' },
  on_hold: { dot: 'bg-chart-4', text: 'text-chart-4', soft: 'bg-chart-4/12 text-chart-4 ring-chart-4/25' },
  resolved: { dot: 'bg-success', text: 'text-success', soft: 'bg-success/12 text-success ring-success/25' },
  closed: { dot: 'bg-subtle-foreground', text: 'text-muted-foreground', soft: 'bg-surface-3 text-muted-foreground ring-border' },
}

export const PRIORITY_STYLE: Record<TicketPriority, { text: string; stripe: string; soft: string }> = {
  urgent: { text: 'text-critical', stripe: 'bg-critical', soft: 'bg-critical/12 text-critical ring-critical/30' },
  high: { text: 'text-warning', stripe: 'bg-warning', soft: 'bg-warning/14 text-warning ring-warning/30' },
  normal: { text: 'text-secondary-foreground', stripe: 'bg-info/70', soft: 'bg-surface-3 text-secondary-foreground ring-border' },
  low: { text: 'text-subtle-foreground', stripe: 'bg-surface-4', soft: 'bg-surface-3 text-muted-foreground ring-border' },
}

export const SOURCE_ICON: Record<TicketSource, LucideIcon> = {
  console: Inbox,
  email: Mail,
  agent: Bot,
  alert: TriangleExclamationPoint,
  api: Code,
}

export const TYPE_ICON: Record<TicketType, LucideIcon> = {
  incident: LifeBuoy,
  request: GitPullRequestArrow,
  problem: Bug,
  change: Wrench,
  alert: OctagonAlert,
}

export const SLA_TONE: Record<SlaTone, string> = {
  ok: 'bg-success/10 text-success ring-success/25',
  due_soon: 'bg-warning/14 text-warning ring-warning/30',
  breached: 'bg-critical/12 text-critical ring-critical/30',
  paused: 'bg-surface-3 text-muted-foreground ring-border',
  met: 'bg-transparent text-subtle-foreground ring-border',
  met_late: 'bg-transparent text-critical/80 ring-critical/20',
}

export const DEVICE_ICON = MonitorSmartphone
