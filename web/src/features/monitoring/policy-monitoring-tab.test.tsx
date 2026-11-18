import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, within } from '@testing-library/react'
import type { PolicyDocument } from '@/lib/api/types'
import { CHECK_TYPES } from '@/mocks/monitoring-catalog'
import { PolicyMonitoringTab } from './policy-monitoring-tab'

const DOC: PolicyDocument = {
  monitoring: {
    checks: [
      { id: 'cpu-high', type: 'cpu', name: 'High CPU', interval_secs: 60, config: { warn_pct: 90, crit_pct: 98, window_minutes: 15 } },
      { id: 'svc', type: 'service', name: 'Spooler', severity: 'critical', config: { name: 'Spooler', expected: 'running' } },
      { id: 'uptime', enabled: false },
    ],
    server: { offline_minutes: 5 },
  },
}

function Harness({ locked = false, onDoc }: { locked?: boolean; onDoc?: (doc: PolicyDocument) => void }) {
  const [doc, setDoc] = useState(DOC)
  return (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { enabled: false } } })}>
      <PolicyMonitoringTab
        doc={doc}
        onChange={(next) => {
          setDoc(next)
          onDoc?.(next)
        }}
        readOnly={false}
        locked={locked}
        issues={[{ path: 'monitoring.checks[0].config.crit_pct', message: 'Must be at least the warning threshold' }]}
        catalog={CHECK_TYPES}
        catalogLoading={false}
      />
    </QueryClientProvider>
  )
}

describe('policy monitoring tab', () => {
  it('lists checks, overrides and server settings', () => {
    render(<Harness />)
    expect(screen.getByText('High CPU')).toBeInTheDocument()
    expect(screen.getByText('Spooler')).toBeInTheDocument()
    expect(screen.getByText(/Override of/)).toBeInTheDocument()
    expect(screen.getByText('Offline alert')).toBeInTheDocument()
    expect(screen.getByText(/2 checks and 1 override/)).toBeInTheDocument()
  })

  it('opens a check and edits its generated config form', () => {
    let latest: PolicyDocument | null = null
    render(<Harness onDoc={(doc) => (latest = doc)} />)
    fireEvent.click(screen.getByText('High CPU'))
    expect(screen.getByText('Must be at least the warning threshold')).toBeInTheDocument()
    const warn = screen.getByLabelText(/Warning at/)
    fireEvent.change(warn, { target: { value: '80' } })
    expect(latest!.monitoring?.checks?.[0].config?.warn_pct).toBe(80)
    // Graded types explain the severity instead of offering a control.
    expect(screen.getByText(/Follows the check’s state/)).toBeInTheDocument()
  })

  it('adds a check from the type picker and is read-only when locked', () => {
    const { unmount } = render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: /Add check/ }))
    const dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByText('Disk space'))
    expect(screen.getAllByText('Disk space').length).toBeGreaterThan(0)
    unmount()
    render(<Harness locked />)
    expect(screen.getByText(/need the/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Add check/ })).toBeNull()
  })
})
