/*
 * The twelve dashboard widgets: what each shows, the permission its data needs, sensible sizes and
 * which settings it takes (`GET /dashboards/widgets/{widget}?config=`).
 */
import type { WidgetConfig, WidgetName, WidgetPlacement } from '@/lib/api/types'
import type { Size } from './grid'
import { CONFIG_MAX_BYTES, configBytes } from './grid'

export type WidgetSetting = 'client' | 'site' | 'limit' | 'field' | 'days'

export interface WidgetDef {
  name: WidgetName
  label: string
  description: string
  permission: string
  category: 'Fleet' | 'Monitoring' | 'Patching' | 'Helpdesk' | 'Automation'
  defaultSize: Size
  minSize: Size
  settings: WidgetSetting[]
  /** Default `limit` for list widgets. */
  defaultLimit?: number
}

export const WIDGETS: WidgetDef[] = [
  { name: 'fleet_health', label: 'Fleet health', description: 'Devices online and their health score bands.', permission: 'devices.view', category: 'Fleet', defaultSize: { w: 4, h: 3 }, minSize: { w: 3, h: 2 }, settings: ['client', 'site'] },
  { name: 'alerts_by_severity', label: 'Alerts by severity', description: 'Unresolved alerts by severity, and how many are acknowledged.', permission: 'alerts.view', category: 'Monitoring', defaultSize: { w: 4, h: 3 }, minSize: { w: 3, h: 2 }, settings: ['client', 'site'] },
  { name: 'alerts_list', label: 'Open alerts', description: 'The most urgent unresolved alerts, by severity then newest.', permission: 'alerts.view', category: 'Monitoring', defaultSize: { w: 8, h: 5 }, minSize: { w: 4, h: 3 }, settings: ['client', 'site', 'limit'], defaultLimit: 10 },
  { name: 'patch_compliance', label: 'Patch compliance', description: 'Compliant devices and missing critical or important updates.', permission: 'patches.view', category: 'Patching', defaultSize: { w: 4, h: 3 }, minSize: { w: 3, h: 2 }, settings: ['client', 'site'] },
  { name: 'tickets_open', label: 'Open tickets', description: 'Active tickets by status and priority.', permission: 'tickets.view', category: 'Helpdesk', defaultSize: { w: 4, h: 3 }, minSize: { w: 3, h: 2 }, settings: ['client', 'site'] },
  { name: 'sla_breaches', label: 'SLA breaches', description: 'Tickets that missed their first-response or resolution target.', permission: 'tickets.view', category: 'Helpdesk', defaultSize: { w: 6, h: 4 }, minSize: { w: 4, h: 3 }, settings: ['client', 'site', 'limit'], defaultLimit: 10 },
  { name: 'devices_offline', label: 'Offline devices', description: 'Devices offline the longest.', permission: 'devices.view', category: 'Fleet', defaultSize: { w: 4, h: 5 }, minSize: { w: 3, h: 3 }, settings: ['client', 'site', 'limit'], defaultLimit: 10 },
  { name: 'os_mix', label: 'Operating systems', description: 'The share of each operating system in the fleet.', permission: 'devices.view', category: 'Fleet', defaultSize: { w: 4, h: 3 }, minSize: { w: 3, h: 3 }, settings: ['client', 'site'] },
  { name: 'agent_versions', label: 'Agent versions', description: 'Agent versions in use and how many are outdated.', permission: 'devices.view', category: 'Fleet', defaultSize: { w: 4, h: 3 }, minSize: { w: 3, h: 2 }, settings: ['client', 'site'] },
  { name: 'top_disk_usage', label: 'Fullest disks', description: 'Devices with the fullest system drive.', permission: 'devices.view', category: 'Fleet', defaultSize: { w: 4, h: 4 }, minSize: { w: 3, h: 3 }, settings: ['client', 'site', 'limit'], defaultLimit: 10 },
  { name: 'recent_jobs', label: 'Recent jobs', description: 'The latest script job runs and their results.', permission: 'scripts.view', category: 'Automation', defaultSize: { w: 6, h: 4 }, minSize: { w: 4, h: 3 }, settings: ['client', 'site', 'limit', 'days'], defaultLimit: 10 },
  { name: 'custom_field_breakdown', label: 'Custom field breakdown', description: 'Devices grouped by the value of a device custom field.', permission: 'devices.view', category: 'Fleet', defaultSize: { w: 4, h: 4 }, minSize: { w: 3, h: 3 }, settings: ['client', 'site', 'limit', 'field'], defaultLimit: 10 },
]

export const WIDGET_BY_NAME: Record<WidgetName, WidgetDef> = Object.fromEntries(WIDGETS.map((def) => [def.name, def])) as Record<WidgetName, WidgetDef>

export const WIDGET_CATEGORIES: WidgetDef['category'][] = ['Fleet', 'Monitoring', 'Patching', 'Helpdesk', 'Automation']

export function widgetDef(name: string): WidgetDef | undefined {
  return WIDGET_BY_NAME[name as WidgetName]
}

/** Widgets whose data the user may see. */
export function availableWidgets(permissions: readonly string[] | undefined): WidgetDef[] {
  return WIDGETS.filter((def) => permissions?.includes(def.permission))
}

export function widgetTitle(placement: Pick<WidgetPlacement, 'widget' | 'config'>): string {
  return placement.config.title?.trim() || widgetDef(placement.widget)?.label || placement.widget
}

export type ConfigIssues = Partial<Record<'limit' | 'days' | 'field' | 'title' | 'size', string>>

/** The server's config rules: limit 1–100, days 1–90, a field for the breakdown, at most 4 KB. */
export function configIssues(widget: WidgetName, config: WidgetConfig): ConfigIssues {
  const issues: ConfigIssues = {}
  const def = WIDGET_BY_NAME[widget]
  if (config.limit !== undefined && config.limit !== null && (!Number.isInteger(config.limit) || config.limit < 1 || config.limit > 100)) issues.limit = 'Show 1–100 items'
  if (config.days !== undefined && config.days !== null && (!Number.isInteger(config.days) || config.days < 1 || config.days > 90)) issues.days = 'Look back 1–90 days'
  if (def?.settings.includes('field') && !config.field) issues.field = 'Choose a custom field'
  if ((config.title ?? '').length > 80) issues.title = 'At most 80 characters'
  if (configBytes(config) > CONFIG_MAX_BYTES) issues.size = 'These settings are larger than 4 KB'
  return issues
}

/** Drops settings a widget does not take (for example a site without a client). */
export function cleanConfig(widget: WidgetName, config: WidgetConfig): WidgetConfig {
  const def = WIDGET_BY_NAME[widget]
  const out: WidgetConfig = {}
  if (config.title?.trim()) out.title = config.title.trim()
  if (def?.settings.includes('client') && config.client_id) out.client_id = config.client_id
  if (def?.settings.includes('site') && config.client_id && config.site_id) out.site_id = config.site_id
  if (def?.settings.includes('limit') && config.limit) out.limit = config.limit
  if (def?.settings.includes('days') && config.days) out.days = config.days
  if (def?.settings.includes('field') && config.field) out.field = config.field
  return out
}

/** The built-in Home layout (mirrors the server's, used before `GET /dashboards/default` answers). */
export const BUILTIN_HOME_LAYOUT: WidgetPlacement[] = [
  { widget: 'fleet_health', x: 0, y: 0, w: 4, h: 3, config: {} },
  { widget: 'alerts_by_severity', x: 4, y: 0, w: 4, h: 3, config: {} },
  { widget: 'patch_compliance', x: 8, y: 0, w: 4, h: 3, config: {} },
  { widget: 'alerts_list', x: 0, y: 3, w: 8, h: 5, config: {} },
  { widget: 'devices_offline', x: 8, y: 3, w: 4, h: 5, config: {} },
  { widget: 'tickets_open', x: 0, y: 8, w: 4, h: 3, config: {} },
  { widget: 'os_mix', x: 4, y: 8, w: 4, h: 3, config: {} },
  { widget: 'agent_versions', x: 8, y: 8, w: 4, h: 3, config: {} },
]

export const BUILTIN_HOME_ID = 'builtin-home'
