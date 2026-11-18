import { Activity, Bell, ChartPie, CircleGauge, ClipboardList, Cpu, HardDrive, ListChecks, PlugZap, ShieldCheck, Timer, type LucideIcon } from 'lucide-react'
import type { WidgetName } from '@/lib/api/types'

export const WIDGET_ICON: Record<WidgetName, LucideIcon> = {
  fleet_health: CircleGauge,
  alerts_by_severity: Bell,
  alerts_list: Activity,
  patch_compliance: ShieldCheck,
  tickets_open: ClipboardList,
  sla_breaches: Timer,
  devices_offline: PlugZap,
  os_mix: ChartPie,
  agent_versions: Cpu,
  top_disk_usage: HardDrive,
  recent_jobs: ListChecks,
  custom_field_breakdown: ChartPie,
}
