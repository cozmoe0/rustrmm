/*
 * Shaping report `Section`s for the console viewer: cell and KPI formatting, sortable table rows,
 * chart data for recharts, and text paragraphs. The PDF renderer reads the same model server-side.
 */
import type { KpiTone, ReportCell, ReportColumn, ReportColumnFormat, ReportKpi, ReportSection } from '@/lib/api/types'
import { formatBytes, formatDate, formatDateTime, formatNumber } from '@/lib/format'

/** Minutes → "45 min", "2 h 5 min", "3 d 4 h". */
export function formatMinutes(minutes: number): string {
  if (!Number.isFinite(minutes)) return '—'
  const total = Math.round(minutes)
  if (Math.abs(total) < 60) return `${total} min`
  const days = Math.floor(total / 1440)
  const hours = Math.floor((total % 1440) / 60)
  const mins = total % 60
  if (days > 0) return hours ? `${days} d ${hours} h` : `${days} d`
  return mins ? `${hours} h ${mins} min` : `${hours} h`
}

function decimals(value: number, max = 1): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: max }).format(value)
}

function asNumber(value: ReportCell): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  return null
}

/** A table cell as text, following its column format. */
export function formatCell(value: ReportCell, format: ReportColumnFormat | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—'
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  switch (format) {
    case 'number': {
      const number = asNumber(value)
      return number === null ? String(value) : Number.isInteger(number) ? formatNumber(number) : decimals(number, 2)
    }
    case 'percent': {
      const number = asNumber(value)
      return number === null ? String(value) : `${decimals(number)}%`
    }
    case 'bytes': {
      const number = asNumber(value)
      return number === null ? String(value) : formatBytes(number)
    }
    case 'duration': {
      const number = asNumber(value)
      return number === null ? String(value) : formatMinutes(number)
    }
    case 'date':
      return Number.isNaN(new Date(String(value)).getTime()) ? String(value) : formatDate(String(value))
    case 'datetime':
      return Number.isNaN(new Date(String(value)).getTime()) ? String(value) : formatDateTime(String(value))
    default:
      return String(value)
  }
}

/** Number-like formats align right unless the column says otherwise. */
export function columnAlign(column: ReportColumn): 'left' | 'right' {
  if (column.align) return column.align
  return column.format && ['number', 'percent', 'bytes', 'duration'].includes(column.format) ? 'right' : 'left'
}

function sortKey(value: ReportCell, format: ReportColumnFormat | null | undefined): number | string | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'boolean') return value ? 1 : 0
  if (format === 'date' || format === 'datetime') {
    const time = new Date(String(value)).getTime()
    return Number.isNaN(time) ? String(value).toLowerCase() : time
  }
  const number = asNumber(value)
  if (number !== null && format !== 'text') return number
  return String(value).toLowerCase()
}

/** Compares two cells; empty cells sort last in both directions. */
export function compareCells(a: ReportCell, b: ReportCell, format: ReportColumnFormat | null | undefined): number {
  const ka = sortKey(a, format)
  const kb = sortKey(b, format)
  if (ka === null && kb === null) return 0
  if (ka === null) return 1
  if (kb === null) return -1
  if (typeof ka === 'number' && typeof kb === 'number') return ka - kb
  return String(ka).localeCompare(String(kb), undefined, { numeric: true, sensitivity: 'base' })
}

export interface TableSort {
  column: number
  desc: boolean
}

/** A sorted copy of the rows (stable; empty cells stay at the bottom). */
export function sortRows(rows: readonly ReportCell[][], columns: readonly ReportColumn[], sort: TableSort | null): ReportCell[][] {
  if (!sort || !columns[sort.column]) return [...rows]
  const format = columns[sort.column].format
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const av = a.row[sort.column] ?? null
      const bv = b.row[sort.column] ?? null
      const emptyA = sortKey(av, format) === null
      const emptyB = sortKey(bv, format) === null
      if (emptyA !== emptyB) return emptyA ? 1 : -1
      const order = compareCells(av, bv, format)
      return (sort.desc ? -order : order) || a.index - b.index
    })
    .map((entry) => entry.row)
}

/** The next sort when a header is activated: ascending → descending → off. Numbers start descending. */
export function nextSort(current: TableSort | null, column: number, columns: readonly ReportColumn[]): TableSort | null {
  const numeric = columnAlign(columns[column]) === 'right'
  if (!current || current.column !== column) return { column, desc: numeric }
  if (current.desc === numeric) return { column, desc: !numeric }
  return null
}

// ------------------------------------------------------------------ KPIs

const UNIT_SUFFIX: Record<string, string> = { '%': '%', GB: ' GB', h: ' h', years: ' years', min: '' }

/** A KPI value with its unit: "92.4%", "1 h 5 min", "512 GB", "—". */
export function formatKpi(item: Pick<ReportKpi, 'value' | 'unit'>): string {
  const { value, unit } = item
  if (value === null || value === undefined || value === '') return '—'
  if (typeof value === 'string') return unit && unit !== '%' ? `${value} ${unit}` : `${value}${unit === '%' ? '%' : ''}`
  if (unit === 'min') return formatMinutes(value)
  const text = Number.isInteger(value) ? formatNumber(value) : decimals(value)
  if (!unit) return text
  return `${text}${UNIT_SUFFIX[unit] ?? ` ${unit}`}`
}

export function kpiTone(item: Pick<ReportKpi, 'tone'>): KpiTone {
  return item.tone ?? 'neutral'
}

// ------------------------------------------------------------------ charts

/** recharts data keys must be plain identifiers, so series are keyed by position. */
export const seriesKey = (index: number) => `s${index}`

export type CartesianRow = { label: string } & Record<string, number | string>

/** One row per label with each series under `s0`, `s1`, … (missing values become 0). */
export function cartesianData(section: Extract<ReportSection, { kind: 'chart' }>): CartesianRow[] {
  return section.labels.map((label, index) => {
    const row: CartesianRow = { label }
    section.series.forEach((series, seriesIndex) => {
      const value = series.values[index]
      row[seriesKey(seriesIndex)] = Number.isFinite(value) ? value : 0
    })
    return row
  })
}

export interface DonutSlice {
  key: string
  label: string
  value: number
  share: number
}

/**
 * Donut slices from the first series, largest first; slices beyond `max` fold into "Other" so the
 * legend stays readable.
 */
export function donutData(section: Extract<ReportSection, { kind: 'chart' }>, max = 7): DonutSlice[] {
  const values = section.series[0]?.values ?? []
  const entries = section.labels
    .map((label, index) => ({ label, value: Number.isFinite(values[index]) ? Math.max(0, values[index]) : 0 }))
    .filter((entry) => entry.value > 0)
    .sort((a, b) => b.value - a.value)
  const total = entries.reduce((sum, entry) => sum + entry.value, 0)
  const head = entries.length > max ? entries.slice(0, max - 1) : entries
  const tail = entries.length > max ? entries.slice(max - 1) : []
  const slices = head.map((entry, index) => ({ key: `slice${index}`, label: entry.label, value: entry.value, share: total ? entry.value / total : 0 }))
  if (tail.length) {
    const value = tail.reduce((sum, entry) => sum + entry.value, 0)
    slices.push({ key: `slice${slices.length}`, label: `Other (${tail.length})`, value, share: total ? value / total : 0 })
  }
  return slices
}

export function chartTotal(section: Extract<ReportSection, { kind: 'chart' }>): number {
  return section.series.reduce((sum, series) => sum + series.values.reduce((inner, value) => inner + (Number.isFinite(value) ? value : 0), 0), 0)
}

/** Formats a chart value with the section's unit. */
export function formatChartValue(value: number, unit: string | null | undefined): string {
  if (unit === 'min') return formatMinutes(value)
  if (unit === '%') return `${decimals(value)}%`
  const text = Number.isInteger(value) ? formatNumber(value) : decimals(value)
  return unit ? `${text} ${unit}` : text
}

// ------------------------------------------------------------------ text, anchors

/** Plain-text paragraphs (separated by blank lines; no markup is interpreted). */
export function paragraphs(body: string): string[] {
  return body
    .split(/\r?\n\s*\r?\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
}

/** A stable DOM id for a section (for the outline). */
export function sectionAnchor(title: string, index: number): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  return `section-${index}-${slug || 'untitled'}`
}

/** Cells reading Pass/Fail (security posture matrix) get a tone. */
export function cellTone(value: ReportCell): 'good' | 'bad' | null {
  if (value === 'Pass' || value === true) return 'good'
  if (value === 'Fail' || value === false) return 'bad'
  return null
}

/** How many sections of each kind (for the viewer header). */
export function sectionCounts(sections: readonly ReportSection[]): Record<ReportSection['kind'], number> {
  const counts = { kpis: 0, table: 0, chart: 0, text: 0, list: 0 }
  for (const section of sections) counts[section.kind] += 1
  return counts
}
