import { describe, expect, it } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import type { MaintenanceWindow } from '@/lib/api/types'
import { MaintenanceEditor } from './maintenance-editor'

const WINDOW: MaintenanceWindow = {
  id: 'w1',
  name: 'Patch night',
  enabled: true,
  targets: [{ type: 'client', id: 'c1', name: 'Summit Freight' }],
  schedule: { type: 'recurring', cron: '0 22 * * 3', duration_minutes: 180, timezone: 'UTC' },
  suppress: 'notifications',
  created_by_name: 'Jordan Patel',
  active_now: false,
  next_start: '2026-11-25T22:00:00Z',
}

function renderEditor(props: Partial<Parameters<typeof MaintenanceEditor>[0]> = {}) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { enabled: false } } })}>
      <MaintenanceEditor existing={WINDOW} creating={false} open canManage onClose={() => {}} {...props} />
    </QueryClientProvider>,
  )
}

describe('maintenance editor', () => {
  it('shows an existing recurring window with its preview', () => {
    renderEditor()
    expect(screen.getByDisplayValue('Patch night')).toBeInTheDocument()
    expect(screen.getByText('Summit Freight')).toBeInTheDocument()
    expect(screen.getByText('Weekly on Wednesday at 22:00 for 3 h · UTC')).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /Hold notifications/ })).toHaveAttribute('aria-checked', 'true')
  })

  it('validates a new window on save', () => {
    renderEditor({ existing: null, creating: true })
    fireEvent.click(screen.getByRole('button', { name: 'Create window' }))
    expect(screen.getByText('Enter a name')).toBeInTheDocument()
    expect(screen.getByText('Choose at least one target')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Everywhere/ }))
    expect(screen.getByText(/Every managed device, in every client/)).toBeInTheDocument()
  })
})
