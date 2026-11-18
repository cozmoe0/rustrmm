import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import type { ReportSection } from '@/lib/api/types'
import { ReportSections } from './report-sections'

const sections: ReportSection[] = [
  { kind: 'text', title: 'Summary', body: 'First paragraph.\n\nSecond paragraph.' },
  {
    kind: 'kpis',
    title: 'Overview',
    items: [
      { label: 'Patch compliance', value: 91.25, unit: '%', tone: 'good' },
      { label: 'MTTR', value: 125, unit: 'min' },
      { label: 'Open critical alerts', value: null },
    ],
  },
  {
    kind: 'table',
    title: 'Devices',
    columns: [
      { key: 'host', label: 'Device' },
      { key: 'ram', label: 'RAM', format: 'number' },
      { key: 'av', label: 'AV' },
    ],
    rows: [
      ['beta', 16, 'Pass'],
      ['alpha', 64, 'Fail'],
      ['gamma', null, null],
    ],
    total_rows: 4000,
  },
  { kind: 'list', title: 'Recommendations', items: ['Enable BitLocker on 3 laptops.'] },
]

describe('report sections', () => {
  it('renders text, KPIs with units, tables and lists', () => {
    render(<ReportSections sections={sections} />)
    expect(screen.getByText('Second paragraph.')).toBeInTheDocument()
    expect(screen.getByText('91.3%')).toBeInTheDocument()
    expect(screen.getByText('2 h 5 min')).toBeInTheDocument()
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('Enable BitLocker on 3 laptops.')).toBeInTheDocument()
    expect(screen.getByText(/4,000 in total/)).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Devices' }).closest('section')).toHaveAttribute('id', 'section-2-devices')
  })

  it('sorts a table from its headers, numbers descending first, empty cells last', () => {
    render(<ReportSections sections={sections} />)
    const table = screen.getByRole('table', { name: 'Devices' })
    const hosts = () => within(table).getAllByRole('row').slice(1).map((row) => within(row).getAllByRole('cell')[0].textContent)
    expect(hosts()).toEqual(['beta', 'alpha', 'gamma'])
    fireEvent.click(within(table).getByRole('button', { name: /RAM/ }))
    expect(hosts()).toEqual(['alpha', 'beta', 'gamma'])
    expect(within(table).getByRole('columnheader', { name: /RAM/ })).toHaveAttribute('aria-sort', 'descending')
    fireEvent.click(within(table).getByRole('button', { name: /RAM/ }))
    expect(hosts()).toEqual(['beta', 'alpha', 'gamma'])
    fireEvent.click(within(table).getByRole('button', { name: /Device/ }))
    expect(hosts()).toEqual(['alpha', 'beta', 'gamma'])
  })
})
