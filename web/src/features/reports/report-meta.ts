import type { LucideIcon } from 'lucide-react'
import { Bell, Boxes, ChartColumn, ClipboardList, Cpu, FileClock, Gauge, List, Radar, ShieldCheck, Table2, Text, Timer } from 'lucide-react'
import type { ReportSection } from '@/lib/api/types'

export type ReportCategory = 'Overview' | 'Inventory' | 'Security & patching' | 'Operations'

export interface ReportMeta {
  icon: LucideIcon
  category: ReportCategory
  /** A one-line "good for" hint under the description. */
  audience: string
  /** Tailwind tone classes for the icon tile. */
  tone: string
}

const TONES = {
  copper: 'bg-primary/12 text-primary ring-primary/25',
  live: 'bg-live/12 text-live ring-live/25',
  info: 'bg-info/12 text-info ring-info/25',
  warning: 'bg-warning/14 text-warning ring-warning/30',
  critical: 'bg-critical/12 text-critical ring-critical/25',
  neutral: 'bg-surface-3 text-muted-foreground ring-border',
}

export const REPORT_META: Record<string, ReportMeta> = {
  executive_summary: { icon: Gauge, category: 'Overview', audience: 'Monthly client reviews and QBRs', tone: TONES.copper },
  hardware_inventory: { icon: Cpu, category: 'Inventory', audience: 'Refresh planning and warranty tracking', tone: TONES.info },
  software_inventory: { icon: Boxes, category: 'Inventory', audience: 'Licence true-ups and shadow IT', tone: TONES.info },
  agent_status: { icon: Radar, category: 'Inventory', audience: 'Agent health and onboarding gaps', tone: TONES.neutral },
  patch_compliance: { icon: ShieldCheck, category: 'Security & patching', audience: 'Compliance evidence and patch backlogs', tone: TONES.live },
  security_posture: { icon: ShieldCheck, category: 'Security & patching', audience: 'Cyber-insurance and audit questionnaires', tone: TONES.critical },
  alert_history: { icon: Bell, category: 'Operations', audience: 'Noise reviews, MTTA and MTTR', tone: TONES.warning },
  tickets_time: { icon: Timer, category: 'Operations', audience: 'Billing, SLA results and workload', tone: TONES.copper },
  audit: { icon: FileClock, category: 'Operations', audience: 'Compliance exports and investigations', tone: TONES.neutral },
}

export const FALLBACK_META: ReportMeta = { icon: ClipboardList, category: 'Operations', audience: '', tone: TONES.neutral }

export function reportMeta(type: string): ReportMeta {
  return REPORT_META[type] ?? FALLBACK_META
}

export const CATEGORY_ORDER: ReportCategory[] = ['Overview', 'Inventory', 'Security & patching', 'Operations']

export const FORMAT_LABEL = { json: 'On screen', csv: 'CSV', pdf: 'PDF' } as const

export const PERMISSION_LABEL: Record<string, string> = {
  'devices.view': 'Devices',
  'software.view': 'Software',
  'patches.view': 'Patches',
  'alerts.view': 'Alerts',
  'tickets.view': 'Tickets',
  'audit.view': 'Audit log',
}

export const SECTION_ICON: Record<ReportSection['kind'], LucideIcon> = { kpis: ChartColumn, table: Table2, chart: ChartColumn, text: Text, list: List }
