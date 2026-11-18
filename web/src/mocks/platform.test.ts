import { describe, expect, it } from 'vitest'
import { layoutIssues } from '@/lib/dashboards/grid'
import { WIDGETS } from '@/lib/dashboards/widgets'
import { scheduleIssues } from '@/lib/reports/schedule'
import { db } from './db'
import { PATCH_STATES, matchesPatchState, patchFactsFor } from './patch-state'
import { REPORT_TYPES, buildReport, placeholderPdf, reportCsv } from './report-builder'
import { widgetData } from './widget-data'

describe('mock Phase 11 seed', () => {
  it('seeds dashboards with valid layouts, schedules the server would accept, and coherent SSO, tokens and webhooks', () => {
    expect(db.platform.dashboards.length).toBeGreaterThanOrEqual(3)
    for (const dashboard of db.platform.dashboards) expect(layoutIssues(dashboard.layout)).toEqual([])
    expect(db.platform.dashboards.some((dashboard) => dashboard.shared)).toBe(true)
    for (const schedule of db.platform.reportSchedules) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { id, next_run_at, last_run_at, last_status, last_error, created_by, created_at, updated_at, ...input } = schedule
      expect(scheduleIssues(input)).toEqual({})
    }
    expect(db.platform.reportRuns.some((run) => run.trigger === 'schedule' && run.emailed_to.length > 0)).toBe(true)
    expect(db.platform.reportRuns.some((run) => run.status === 'failed')).toBe(true)
    const owner = db.roles.find((role) => role.name === 'Owner')!
    expect(db.platform.ssoProviders.flatMap((provider) => provider.role_mappings).some((mapping) => mapping.role_id === owner.id)).toBe(false)
    expect(db.platform.apiTokens.some((token) => new Date(token.expires_at).getTime() < Date.now())).toBe(true)
    expect(new Set(db.platform.deliveries.map((delivery) => delivery.status))).toEqual(new Set(['delivered', 'failed', 'pending']))
    expect(db.clients[0].logo_url).toMatch(/^\/api\/v1\/branding\/files\//)
    const signing = db.platform.signing
    expect(signing.source).toBe('release')
    expect(signing.platforms.map((platform) => `${platform.platform}:${platform.status}`)).toEqual(['windows-x86_64:signed', 'macos-universal:unsigned', 'linux-x86_64:unsigned', 'linux-aarch64:unsigned'])
    expect(signing.platforms[0].files.map((file) => file.format)).toEqual(['pe', 'msi'])
    expect(signing.platforms[1].files[0].method).toBe('adhoc')
  })

  it('grants the new permissions through the built-in roles', () => {
    const role = (name: string) => db.roles.find((item) => item.name === name)!
    expect(role('Technician').permissions).toContain('reports.view')
    expect(role('Technician').permissions).not.toContain('reports.manage')
    expect(role('Administrator').permissions).toEqual(expect.arrayContaining(['reports.manage', 'api.manage', 'settings.manage']))
    expect(role('Auditor').permissions).toContain('reports.view')
  })
})

describe('mock reports', () => {
  it('builds every report type from the fleet with well-formed sections', () => {
    for (const type of REPORT_TYPES) {
      const report = buildReport(type.type, { client_id: 'all' })
      expect(report.title).toBe(type.name)
      expect(report.sections.length).toBeGreaterThan(0)
      for (const section of report.sections) {
        if (section.kind === 'table') for (const row of section.rows) expect(row).toHaveLength(section.columns.length)
        if (section.kind === 'chart') for (const series of section.series) expect(series.values).toHaveLength(section.labels.length)
      }
    }
  })

  it('scopes to a client and adds the per-client table only for all clients', () => {
    const client = db.clients[2]
    const scoped = buildReport('executive_summary', { client_id: client.id })
    expect(scoped.client).toEqual({ id: client.id, name: client.name })
    expect(scoped.sections.some((section) => section.title === 'Clients')).toBe(false)
    expect(buildReport('executive_summary', { client_id: 'all' }).sections.some((section) => section.title === 'Clients')).toBe(true)
    const recommendations = scoped.sections.find((section) => section.kind === 'list')
    expect(recommendations?.kind === 'list' && recommendations.items.length).toBeGreaterThan(0)
  })

  it('writes CSV with a BOM and neutralised formulas, and a structurally valid PDF', () => {
    const report = buildReport('audit', { client_id: 'all' })
    report.sections.push({ kind: 'table', title: 'Injection', columns: [{ key: 'a', label: 'A' }], rows: [['=HYPERLINK("x")'], [-5]] })
    const csv = reportCsv(report)
    expect(csv.charCodeAt(0)).toBe(0xfeff)
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`)
    expect(csv).toContain('\r\n-5\r\n')
    const pdf = new TextDecoder().decode(placeholderPdf(report))
    expect(pdf.startsWith('%PDF-1.4')).toBe(true)
    const xref = Number(/startxref\n(\d+)/.exec(pdf)![1])
    expect(pdf.slice(xref, xref + 4)).toBe('xref')
    expect(pdf.trimEnd().endsWith('%%EOF')).toBe(true)
  })
})

describe('mock widgets and patch states', () => {
  it('answers every widget with its documented shape', () => {
    for (const def of WIDGETS) {
      const data = widgetData(def.name, def.name === 'custom_field_breakdown' ? { field: 'warranty_end' } : {}) as unknown as Record<string, unknown>
      expect(data, def.name).toBeTruthy()
    }
    const fleet = widgetData('fleet_health', {})
    expect(fleet.online + fleet.offline).toBe(fleet.devices)
    expect(fleet.buckets.healthy + fleet.buckets.warning + fleet.buckets.critical).toBeLessThanOrEqual(fleet.devices)
    expect(widgetData('alerts_list', { limit: 3 }).items.length).toBeLessThanOrEqual(3)
    const breakdown = widgetData('custom_field_breakdown', { field: 'warranty_end' })
    expect(breakdown.items.reduce((sum, item) => sum + item.count, 0)).toBeGreaterThan(0)
  })

  it('classifies devices by patch state consistently', () => {
    const devices = db.devices.filter((device) => device.status === 'active')
    const facts = patchFactsFor(devices)
    for (const device of devices) {
      const fact = facts.get(device.id)!
      expect(matchesPatchState(fact, 'compliant') && matchesPatchState(fact, 'non_compliant')).toBe(false)
      expect(matchesPatchState(fact, 'not_scanned')).toBe(!fact.scanned)
      if (fact.missing_critical > 0) expect(matchesPatchState(fact, 'missing_critical')).toBe(true)
    }
    expect(PATCH_STATES).toHaveLength(6)
    expect(devices.some((device) => matchesPatchState(facts.get(device.id), 'non_compliant'))).toBe(true)
  })
})
