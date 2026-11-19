import { toast } from 'sonner'
import type { AgentUpdateResult } from '@/lib/api/types'
import { formatAgentVersion } from '@/lib/agent-version'
import { formatNumber } from '@/lib/format'

export const AGENT_UPDATE_VIEWS = ['attention', 'updating', 'failed', 'current', 'all'] as const
export type AgentUpdateView = (typeof AGENT_UPDATE_VIEWS)[number]

export interface AgentUpdatesSearch {
  show?: AgentUpdateView
}

/** Toast for an "Update now" result. */
export function announceUpdate(result: AgentUpdateResult, requested: number) {
  const version = formatAgentVersion(result.version)
  if (result.targeted === 0) {
    toast.info(requested === 1 ? 'Nothing to update' : 'No device needed an update', {
      description: `Already on ${version}, or the release has no build for the platform.`,
    })
  } else {
    toast.success(`Updating ${formatNumber(result.targeted)} ${result.targeted === 1 ? 'agent' : 'agents'}`, {
      description: `Online devices start now; offline ones update when they reconnect. Target: ${version}.`,
    })
  }
}

