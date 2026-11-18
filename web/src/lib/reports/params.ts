/*
 * Report parameters in the console: period presets, the typed form → API body, and the viewer URL
 * (so a report on screen can be refreshed, bookmarked and shared).
 */
import type { ReportParameters, ReportTypeInfo } from '@/lib/api/types'

const DAY = 86_400_000

export type PeriodPreset = 'last_7' | 'last_30' | 'last_90' | 'this_month' | 'last_month' | 'this_quarter' | 'last_quarter' | 'custom'

export const PERIOD_PRESETS: { value: PeriodPreset; label: string }[] = [
  { value: 'last_7', label: 'Last 7 days' },
  { value: 'last_30', label: 'Last 30 days' },
  { value: 'last_90', label: 'Last 90 days' },
  { value: 'this_month', label: 'This month' },
  { value: 'last_month', label: 'Last month' },
  { value: 'this_quarter', label: 'This quarter' },
  { value: 'last_quarter', label: 'Last quarter' },
  { value: 'custom', label: 'Custom range' },
]

export const DEFAULT_PERIOD: PeriodPreset = 'last_30'

export const ALERT_SEVERITIES = ['critical', 'warning', 'info'] as const

export interface PeriodRange {
  from: Date
  to: Date
}

/** `YYYY-MM-DD` in local time. */
export function toDateInput(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function parseDateInput(value: string, endOfDay: boolean): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return null
  const date = endOfDay
    ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 23, 59, 59, 999)
    : new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 0, 0, 0, 0)
  return Number.isNaN(date.getTime()) ? null : date
}

/** The instants a preset covers (calendar presets use local time; "this …" ends now). */
export function periodRange(preset: PeriodPreset, now = new Date(), custom?: { from: string; to: string }): PeriodRange | null {
  const startOfMonth = (year: number, month: number) => new Date(year, month, 1, 0, 0, 0, 0)
  switch (preset) {
    case 'last_7':
      return { from: new Date(now.getTime() - 7 * DAY), to: now }
    case 'last_30':
      return { from: new Date(now.getTime() - 30 * DAY), to: now }
    case 'last_90':
      return { from: new Date(now.getTime() - 90 * DAY), to: now }
    case 'this_month':
      return { from: startOfMonth(now.getFullYear(), now.getMonth()), to: now }
    case 'last_month':
      return { from: startOfMonth(now.getFullYear(), now.getMonth() - 1), to: new Date(startOfMonth(now.getFullYear(), now.getMonth()).getTime() - 1) }
    case 'this_quarter': {
      const quarter = Math.floor(now.getMonth() / 3) * 3
      return { from: startOfMonth(now.getFullYear(), quarter), to: now }
    }
    case 'last_quarter': {
      const quarter = Math.floor(now.getMonth() / 3) * 3
      return { from: startOfMonth(now.getFullYear(), quarter - 3), to: new Date(startOfMonth(now.getFullYear(), quarter).getTime() - 1) }
    }
    case 'custom': {
      if (!custom) return null
      const from = parseDateInput(custom.from, false)
      const to = parseDateInput(custom.to, true)
      if (!from || !to) return null
      return { from, to }
    }
  }
}

/** Why a custom range is unusable, or null. */
export function customRangeError(from: string, to: string, now = new Date()): string | null {
  const range = periodRange('custom', now, { from, to })
  if (!range) return 'Choose a start and an end date'
  if (range.from.getTime() > range.to.getTime()) return 'The start must be before the end'
  if (range.from.getTime() > now.getTime()) return 'The period cannot start in the future'
  if (range.to.getTime() - range.from.getTime() > 366 * DAY) return 'At most one year per report'
  return null
}

/** The typed form behind the run dialog and the schedule editor. */
export interface ReportForm {
  clientId: string | null
  siteId: string | null
  period: PeriodPreset
  customFrom: string
  customTo: string
  products: string[]
  severity: string | null
  action: string
  actor: string
}

export function emptyReportForm(clientId: string | null = null, now = new Date()): ReportForm {
  return {
    clientId,
    siteId: null,
    period: DEFAULT_PERIOD,
    customFrom: toDateInput(new Date(now.getTime() - 30 * DAY)),
    customTo: toDateInput(now),
    products: [],
    severity: null,
    action: '',
    actor: '',
  }
}

/** Whether a report type accepts a parameter (from `GET /reports/types`). */
export function acceptsParam(type: Pick<ReportTypeInfo, 'parameters'> | undefined, name: string): boolean {
  return Boolean(type?.parameters.some((param) => param.name === name))
}

/**
 * The API body for a form. Type-specific parameters are only sent to types that take them;
 * schedules (`withPeriod: false`) never send `from`/`to`.
 */
export function buildParameters(type: Pick<ReportTypeInfo, 'parameters'> | undefined, form: ReportForm, options: { withPeriod?: boolean; now?: Date } = {}): ReportParameters {
  const { withPeriod = true, now = new Date() } = options
  const params: ReportParameters = { client_id: form.clientId ?? 'all' }
  if (form.clientId && form.siteId) params.site_id = form.siteId
  if (withPeriod) {
    const range = periodRange(form.period, now, { from: form.customFrom, to: form.customTo })
    if (range) {
      params.from = range.from.toISOString()
      params.to = range.to.toISOString()
    }
  }
  if (acceptsParam(type, 'products') && form.products.length) params.products = [...form.products]
  if (acceptsParam(type, 'severity') && form.severity) params.severity = form.severity
  if (acceptsParam(type, 'action') && form.action.trim()) params.action = form.action.trim()
  if (acceptsParam(type, 'actor') && form.actor.trim()) params.actor = form.actor.trim()
  return params
}

/** A form back from stored parameters (schedules, run history). */
export function formFromParameters(params: ReportParameters, now = new Date()): ReportForm {
  const form = emptyReportForm(params.client_id && params.client_id !== 'all' ? params.client_id : null, now)
  form.siteId = params.site_id ?? null
  if (params.from && params.to) {
    form.period = 'custom'
    form.customFrom = toDateInput(new Date(params.from))
    form.customTo = toDateInput(new Date(params.to))
  }
  form.products = params.products ?? []
  form.severity = params.severity ?? null
  form.action = params.action ?? ''
  form.actor = params.actor ?? ''
  return form
}

// ------------------------------------------------------------------ viewer URL

/** `/reports/view` search params. Period presets stay symbolic so a refresh moves the window. */
export interface ReportViewSearch {
  type: string
  client?: string
  site?: string
  period?: PeriodPreset
  from?: string
  to?: string
  products?: string
  severity?: string
  action?: string
  actor?: string
}

export function searchFromForm(type: string, form: ReportForm): ReportViewSearch {
  return {
    type,
    client: form.clientId ?? undefined,
    site: form.clientId ? (form.siteId ?? undefined) : undefined,
    period: form.period === DEFAULT_PERIOD ? undefined : form.period,
    from: form.period === 'custom' ? form.customFrom : undefined,
    to: form.period === 'custom' ? form.customTo : undefined,
    products: form.products.length ? form.products.join('|') : undefined,
    severity: form.severity ?? undefined,
    action: form.action.trim() || undefined,
    actor: form.actor.trim() || undefined,
  }
}

export function formFromSearch(search: ReportViewSearch, now = new Date()): ReportForm {
  const form = emptyReportForm(search.client ?? null, now)
  form.siteId = search.client ? (search.site ?? null) : null
  form.period = search.period ?? DEFAULT_PERIOD
  if (form.period === 'custom') {
    form.customFrom = search.from ?? form.customFrom
    form.customTo = search.to ?? form.customTo
  }
  form.products = search.products ? search.products.split('|').filter(Boolean) : []
  form.severity = search.severity ?? null
  form.action = search.action ?? ''
  form.actor = search.actor ?? ''
  return form
}

export function periodLabel(form: Pick<ReportForm, 'period' | 'customFrom' | 'customTo'>): string {
  if (form.period !== 'custom') return PERIOD_PRESETS.find((preset) => preset.value === form.period)?.label ?? 'Last 30 days'
  return `${form.customFrom} → ${form.customTo}`
}

/** Human chips for stored parameters (history rows, schedule cards). */
export function parameterChips(params: ReportParameters, names: { client?: (id: string) => string | undefined; site?: (id: string) => string | undefined } = {}): string[] {
  const chips: string[] = []
  if (params.client_id && params.client_id !== 'all') chips.push(names.client?.(params.client_id) ?? 'One client')
  else chips.push('All clients')
  if (params.site_id) chips.push(names.site?.(params.site_id) ?? 'One site')
  if (params.from && params.to) {
    const fmt = (value: string) => new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(value))
    chips.push(`${fmt(params.from)} – ${fmt(params.to)}`)
  }
  if (params.products?.length) chips.push(params.products.length === 1 ? params.products[0] : `${params.products.length} products`)
  if (params.severity) chips.push(`Severity: ${params.severity}`)
  if (params.action) chips.push(`Action: ${params.action}`)
  if (params.actor) chips.push(`Actor: ${params.actor}`)
  return chips
}
