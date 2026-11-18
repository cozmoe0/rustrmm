import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Can } from '@/components/common/can'
import { keys } from './api/queries'
import type { Me } from './api/types'
import { hasAnyPermission, hasPermission } from './permissions'

function makeMe(permissions: string[]): Me {
  return {
    user: { id: 'u1', name: 'Avery Chen', email: 'avery@example.com', mfa: { totp: true, passkeys: 0 }, created_at: '' },
    csrf_token: 'csrf',
    permissions,
    scopes: { global: true, client_ids: [], site_ids: [] },
    organization: { name: 'Lumen IT' },
    session: { id: 's1', expires_at: '', idle_expires_at: '', stepped_up_until: null },
  }
}

function renderWithMe(me: Me | undefined, ui: React.ReactNode) {
  const client = new QueryClient()
  if (me) client.setQueryData(keys.me, me)
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

describe('permissions', () => {
  it('checks single and any-of permissions', () => {
    const me = makeMe(['clients.view', 'audit.view'])
    expect(hasPermission(me, 'clients.view')).toBe(true)
    expect(hasPermission(me, 'clients.manage')).toBe(false)
    expect(hasPermission(undefined, 'clients.view')).toBe(false)
    expect(hasAnyPermission(me, ['users.manage', 'audit.view'])).toBe(true)
    expect(hasAnyPermission(me, ['users.manage', 'roles.manage'])).toBe(false)
  })

  it('renders gated content only with the permission', () => {
    renderWithMe(
      makeMe(['clients.view']),
      <>
        <Can permission="clients.view">
          <span>visible</span>
        </Can>
        <Can permission="clients.manage" fallback={<span>fallback</span>}>
          <span>hidden</span>
        </Can>
      </>,
    )
    expect(screen.getByText('visible')).toBeInTheDocument()
    expect(screen.queryByText('hidden')).not.toBeInTheDocument()
    expect(screen.getByText('fallback')).toBeInTheDocument()
  })

  it('hides everything gated when signed out', () => {
    renderWithMe(
      undefined,
      <Can anyOf={['clients.view', 'users.view']}>
        <span>secret</span>
      </Can>,
    )
    expect(screen.queryByText('secret')).not.toBeInTheDocument()
  })
})
