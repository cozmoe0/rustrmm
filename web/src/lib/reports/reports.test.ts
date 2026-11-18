import { describe, expect, it } from 'vitest'
import type { ReportColumn, ReportSection, ReportTypeInfo } from '@/lib/api/types'
import { buildParameters, customRangeError, emptyReportForm, formFromSearch, parameterChips, periodRange, searchFromForm } from './params'
import { describeReportCron, normalizeRecipients, scheduleIssues, scheduleSummary } from './schedule'
import { cartesianData, columnAlign, donutData, formatCell, formatKpi, formatMinutes, nextSort, paragraphs, sectionAnchor, sortRows } from './sections'

const param = (name: string, type: 'string' | 'datetime' | 'array' = 'string') => ({ name, type, required: false, description: '' })
const common = [param('client_id'), param('site_id'), param('from', 'datetime'), param('to', 'datetime')]
const software: ReportTypeInfo = { type: 'software_inventory', name: 'Software', description: '', permission: 'software.view', parameters: [...common, param('products', 'array')] }
const audit: ReportTypeInfo = { type: 'audit', name: 'Audit', description: '', permission: 'audit.view', parameters: [...common, param('action'), param('actor')] }

describe('cell formatting', () => {
  it('follows the column format', () => {
    expect(formatCell(null, 'number')).toBe('—')
    expect(formatCell(1234, 'number')).toBe('1,234')
    expect(formatCell(91.25, 'percent')).toBe('91.3%')
    expect(formatCell(1_610_612_736, 'bytes')).toMatch(/1\.5 GB/)
    expect(formatCell(125, 'duration')).toBe('2 h 5 min')
    expect(formatCell(true, 'text')).toBe('Yes')
    expect(formatCell('Pass', undefined)).toBe('Pass')
  })

  it('formats minutes compactly', () => {
    expect(formatMinutes(45)).toBe('45 min')
    expect(formatMinutes(60)).toBe('1 h')
    expect(formatMinutes(1500)).toBe('1 d 1 h')
  })

  it('formats KPIs with units', () => {
    expect(formatKpi({ value: 92.44, unit: '%' })).toBe('92.4%')
    expect(formatKpi({ value: 18, unit: 'min' })).toBe('18 min')
    expect(formatKpi({ value: 512, unit: 'GB' })).toBe('512 GB')
    expect(formatKpi({ value: 3.25, unit: 'years' })).toBe('3.3 years')
    expect(formatKpi({ value: null, unit: '%' })).toBe('—')
    expect(formatKpi({ value: 'v1.4.2' })).toBe('v1.4.2')
  })
})

describe('table sorting', () => {
  const columns: ReportColumn[] = [
    { key: 'name', label: 'Device' },
    { key: 'ram', label: 'RAM', format: 'number' },
    { key: 'seen', label: 'Last seen', format: 'datetime' },
  ]
  const rows = [
    ['b-host', 16, '2026-11-01T10:00:00Z'],
    ['A-host', 8, null],
    ['c-host', 32, '2026-10-01T10:00:00Z'],
    ['a10', null, '2026-11-10T10:00:00Z'],
    ['a2', 8, '2026-11-02T10:00:00Z'],
  ]

  it('sorts numbers numerically with empty cells last in both directions', () => {
    expect(sortRows(rows, columns, { column: 1, desc: false }).map((row) => row[0])).toEqual(['A-host', 'a2', 'b-host', 'c-host', 'a10'])
    expect(sortRows(rows, columns, { column: 1, desc: true }).map((row) => row[0])).toEqual(['c-host', 'b-host', 'A-host', 'a2', 'a10'])
  })

  it('sorts text naturally and case-insensitively', () => {
    expect(sortRows(rows, columns, { column: 0, desc: false }).map((row) => row[0])).toEqual(['A-host', 'a2', 'a10', 'b-host', 'c-host'])
  })

  it('sorts dates by time', () => {
    expect(sortRows(rows, columns, { column: 2, desc: true }).map((row) => row[0])).toEqual(['a10', 'a2', 'b-host', 'c-host', 'A-host'])
  })

  it('cycles header sorting, starting numbers descending', () => {
    expect(nextSort(null, 1, columns)).toEqual({ column: 1, desc: true })
    expect(nextSort({ column: 1, desc: true }, 1, columns)).toEqual({ column: 1, desc: false })
    expect(nextSort({ column: 1, desc: false }, 1, columns)).toBeNull()
    expect(nextSort(null, 0, columns)).toEqual({ column: 0, desc: false })
    expect(columnAlign(columns[1])).toBe('right')
    expect(columnAlign({ key: 'x', label: 'X', format: 'number', align: 'left' })).toBe('left')
  })
})

describe('chart shaping', () => {
  const chart: Extract<ReportSection, { kind: 'chart' }> = {
    kind: 'chart',
    title: 'Alerts per day',
    chart: 'bar',
    labels: ['Mon', 'Tue'],
    series: [
      { name: 'Critical', values: [1, 2] },
      { name: 'Warning', values: [3] },
    ],
  }

  it('builds one row per label with positional series keys', () => {
    expect(cartesianData(chart)).toEqual([
      { label: 'Mon', s0: 1, s1: 3 },
      { label: 'Tue', s0: 2, s1: 0 },
    ])
  })

  it('builds donut slices largest first and folds the tail into Other', () => {
    const donut: Extract<ReportSection, { kind: 'chart' }> = { kind: 'chart', title: 'OS', chart: 'donut', labels: ['a', 'b', 'c', 'd'], series: [{ name: 'Devices', values: [1, 6, 0, 3] }] }
    const slices = donutData(donut, 2)
    expect(slices.map((slice) => slice.label)).toEqual(['b', 'Other (2)'])
    expect(slices[0].share).toBeCloseTo(0.6)
    expect(slices[1].value).toBe(4)
  })

  it('splits text into paragraphs and makes anchors', () => {
    expect(paragraphs('One.\n\nTwo\nlines.\n\n\n')).toEqual(['One.', 'Two\nlines.'])
    expect(sectionAnchor('Security posture!', 3)).toBe('section-3-security-posture')
  })
})

describe('parameters', () => {
  const now = new Date(2026, 10, 18, 12, 0, 0)

  it('computes calendar periods', () => {
    const lastMonth = periodRange('last_month', now)!
    expect(lastMonth.from.getMonth()).toBe(9)
    expect(lastMonth.from.getDate()).toBe(1)
    expect(lastMonth.to.getMonth()).toBe(9)
    expect(lastMonth.to.getDate()).toBe(31)
    const quarter = periodRange('last_quarter', now)!
    expect(quarter.from.getMonth()).toBe(6)
    expect(quarter.to.getMonth()).toBe(8)
    expect(periodRange('custom', now, { from: '2026-11-01', to: 'x' })).toBeNull()
  })

  it('validates custom ranges', () => {
    expect(customRangeError('2026-11-10', '2026-11-01', now)).toMatch(/before/)
    expect(customRangeError('2027-01-01', '2027-01-02', now)).toMatch(/future/)
    expect(customRangeError('2024-01-01', '2026-01-02', now)).toMatch(/one year/)
    expect(customRangeError('2026-11-01', '2026-11-10', now)).toBeNull()
  })

  it('sends only the parameters a type takes', () => {
    const form = { ...emptyReportForm('client-1', now), siteId: 'site-1', products: ['7-Zip'], action: 'auth.', actor: 'Avery' }
    const params = buildParameters(software, form, { now })
    expect(params.client_id).toBe('client-1')
    expect(params.site_id).toBe('site-1')
    expect(params.products).toEqual(['7-Zip'])
    expect(params.action).toBeUndefined()
    expect(params.from).toBeDefined()
    expect(buildParameters(audit, form, { now })).toMatchObject({ action: 'auth.', actor: 'Avery' })
  })

  it('never sends a period or a lone site for schedules and all-client runs', () => {
    const form = { ...emptyReportForm(null, now), siteId: 'site-1' }
    const params = buildParameters(software, form, { withPeriod: false, now })
    expect(params).toEqual({ client_id: 'all' })
  })

  it('round-trips the viewer URL', () => {
    const form = { ...emptyReportForm('c1', now), period: 'custom' as const, customFrom: '2026-10-01', customTo: '2026-10-31', products: ['A', 'B'] }
    const search = searchFromForm('software_inventory', form)
    expect(search).toMatchObject({ type: 'software_inventory', client: 'c1', period: 'custom', from: '2026-10-01', products: 'A|B' })
    expect(formFromSearch(search, now)).toMatchObject({ clientId: 'c1', period: 'custom', customFrom: '2026-10-01', products: ['A', 'B'] })
    expect(searchFromForm('audit', emptyReportForm(null, now)).period).toBeUndefined()
  })

  it('describes stored parameters', () => {
    expect(parameterChips({ client_id: 'all' })).toEqual(['All clients'])
    expect(parameterChips({ client_id: 'c1', severity: 'critical' }, { client: () => 'Northwind' })).toEqual(['Northwind', 'Severity: critical'])
  })
})

describe('schedules', () => {
  it('describes report cron shapes', () => {
    expect(describeReportCron('0 7 1 * *')).toBe('Monthly on day 1 at 07:00')
    expect(describeReportCron('0 7 * * 1')).toBe('Weekly on Monday at 07:00')
    expect(describeReportCron('0 7 1 1,4,7,10 *')).toBe('Quarterly on day 1 (Jan, Apr, Jul, Oct) at 07:00')
    expect(describeReportCron('30 6 15 3,9 *')).toBe('On day 15 of Mar and Sep at 06:30')
    expect(describeReportCron('0 8 1-7 * 1')).toBe('First Monday of every month at 08:00')
    expect(describeReportCron('0 9 * * 2-4')).toBe('Tuesday to Thursday at 09:00')
    expect(describeReportCron('0 7 * * 1-5')).toBe('Weekdays at 07:00')
    expect(describeReportCron('0 7 1,15 * *')).toBe('Monthly on days 1 and 15 at 07:00')
    expect(describeReportCron('nope')).toBe('Invalid schedule')
    expect(scheduleSummary({ cron: '0 7 1 * *', timezone: 'America/New_York' })).toBe('Monthly on day 1 at 07:00 · America/New York')
  })

  it('applies the server rules', () => {
    const base = { name: 'Monthly exec', type: 'executive_summary', parameters: {}, format: 'pdf' as const, cron: '0 7 1 * *', timezone: 'UTC', recipients: ['ops@example.com'], per_client: false, enabled: true }
    expect(scheduleIssues(base)).toEqual({})
    expect(scheduleIssues({ ...base, recipients: [] })).toHaveProperty('recipients')
    expect(scheduleIssues({ ...base, recipients: [], per_client: true })).toEqual({})
    expect(scheduleIssues({ ...base, recipients: ['not-an-address'] }).recipients).toMatch(/not an e-mail/)
    expect(scheduleIssues({ ...base, cron: '* *' })).toHaveProperty('cron')
    expect(scheduleIssues({ ...base, timezone: 'Mars/Olympus' })).toHaveProperty('timezone')
    expect(scheduleIssues({ ...base, recipients: Array.from({ length: 51 }, (_, index) => `u${index}@example.com`) }).recipients).toMatch(/At most 50/)
  })

  it('normalises recipients like the server', () => {
    expect(normalizeRecipients([' Ops@Example.com', 'ops@example.com', ''])).toEqual(['ops@example.com'])
  })
})
