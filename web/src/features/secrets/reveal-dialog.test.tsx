import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { escrowApi } from '@/lib/api/endpoints'
import type { EscrowItem } from '@/lib/api/types'
import { RevealDialog } from './reveal-dialog'

const ITEM: EscrowItem = {
  id: 'item-1',
  device_id: 'device-1',
  hostname: 'NWD-OP1',
  client_name: 'Northwind Dental',
  kind: 'bitlocker',
  identifier: '{2F1C9A0B-6D3E-4B7A-9C21-0E5D8F3A417D}',
  label: 'C: recovery key',
  metadata: { volume: 'C:', key_protector_id: '{2F1C9A0B-6D3E-4B7A-9C21-0E5D8F3A417D}' },
  captured_at: new Date().toISOString(),
  superseded_at: null,
  last_revealed_at: null,
  reveal_count: 0,
}
const SECRET = '462352-389521-152614-012133-683936-110231-584243-704682'

afterEach(() => vi.restoreAllMocks())

describe('reveal dialog', () => {
  it('needs a reason, shows the key grouped, keeps it out of the query cache and drops it on close', async () => {
    const reveal = vi.spyOn(escrowApi, 'reveal').mockResolvedValue({ secret: SECRET, kind: 'bitlocker', identifier: ITEM.identifier, expires_in: 60 })
    const client = new QueryClient()
    const onOpenChange = vi.fn()
    const { rerender } = render(
      <QueryClientProvider client={client}>
        <RevealDialog item={ITEM} open onOpenChange={onOpenChange} />
      </QueryClientProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: /^reveal$/i }))
    expect(await screen.findByText(/at least 10 characters/i)).toBeInTheDocument()
    expect(reveal).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'BIOS update put OP1 into recovery' } })
    fireEvent.click(screen.getByRole('button', { name: /^reveal$/i }))
    await waitFor(() => expect(reveal).toHaveBeenCalledWith('item-1', 'BIOS update put OP1 into recovery'))

    expect(await screen.findByText('389521')).toBeInTheDocument()
    expect(screen.getAllByRole('listitem')).toHaveLength(8)
    expect(screen.getByRole('timer')).toHaveAccessibleName(/hidden in 60 seconds/i)
    // Neither the query nor the mutation cache ever holds the secret.
    const cached = JSON.stringify([client.getQueryCache().getAll().map((query) => query.state.data), client.getMutationCache().getAll().map((mutation) => mutation.state.data)])
    expect(cached).not.toContain('389521')

    await act(async () => fireEvent.click(screen.getByRole('button', { name: /hide now/i })))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    rerender(
      <QueryClientProvider client={client}>
        <RevealDialog item={ITEM} open={false} onOpenChange={onOpenChange} />
      </QueryClientProvider>,
    )
    await waitFor(() => expect(screen.queryByText('389521')).not.toBeInTheDocument())
  })
})
