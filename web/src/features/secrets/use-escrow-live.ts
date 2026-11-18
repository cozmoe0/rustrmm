import { useQueryClient } from '@tanstack/react-query'
import { escrowKeys } from '@/lib/api/queries'
import { useStreamEvent } from '@/lib/api/stream'
import type { EscrowChangedEvent } from '@/lib/api/types'

/** `escrow.changed` (captured, revealed, superseded or deleted) refreshes escrow metadata. Never carries a secret. */
export function useEscrowLive(enabled: boolean) {
  const queryClient = useQueryClient()
  useStreamEvent<EscrowChangedEvent>('escrow.changed', () => {
    if (!enabled) return
    void queryClient.invalidateQueries({ queryKey: escrowKeys.all })
  })
}
