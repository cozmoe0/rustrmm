import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { CircleFadingArrowUp, Loader } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Spinner } from '@/components/ui/spinner'
import { agentUpdatesApi } from '@/lib/api/endpoints'
import { errorMessage } from '@/lib/api/errors'
import { deviceAgentUpdateQuery, keys } from '@/lib/api/queries'
import { useStreamEvent } from '@/lib/api/stream'
import { UPDATE_STATE_LABEL, canUpdateNow, formatAgentVersion, parseAgentVersion } from '@/lib/agent-version'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'
import { cn } from '@/lib/utils'
import { announceUpdate } from './agent-updates'
import { UpdateStateBadge } from './agent-updates-page'

/**
 * The cockpit header's "Agent" value: the version, and when a newer release exists a pill that
 * opens the update details with "Update now".
 */
export function AgentVersionStat({ deviceId, version }: { deviceId: string; version: string }) {
  const me = useMe()
  const queryClient = useQueryClient()
  const status = useQuery(deviceAgentUpdateQuery(deviceId))
  useStreamEvent<{ device_id?: string }>('agent_updates.changed', (event) => {
    if (!event?.device_id || event.device_id === deviceId) void queryClient.invalidateQueries({ queryKey: keys.deviceAgentUpdate(deviceId) })
  })
  const update = useMutation({
    mutationFn: () => agentUpdatesApi.updateDevice(deviceId),
    onSuccess: (result) => {
      announceUpdate(result, 1)
      void queryClient.invalidateQueries({ queryKey: keys.agentUpdates })
    },
    onError: (error) => toast.error(errorMessage(error, 'Could not start the update')),
  })
  const { base } = parseAgentVersion(version)
  const data = status.data
  const state = data?.state
  const pending = state === 'outdated' || state === 'failed' || state === 'queued' || state === 'updating'
  const canUpdate = hasPermission(me, PERMISSIONS.agentsUpdate)

  return (
    <span className="flex items-center gap-1.5">
      <span className="font-mono text-[13px]" title={version}>
        {base}
      </span>
      {data && pending && (
        <Popover>
          <PopoverTrigger
            render={
              <button
                type="button"
                className={cn(
                  'inline-flex h-5 items-center gap-1 rounded-full px-1.5 text-micro font-medium ring-1 outline-none ring-inset focus-visible:ring-2 focus-visible:ring-ring',
                  state === 'failed'
                    ? 'bg-critical/12 text-critical ring-critical/30'
                    : state === 'outdated'
                      ? 'bg-warning/14 text-warning ring-warning/30'
                      : 'bg-info/12 text-info ring-info/25',
                )}
              />
            }
          >
            {state === 'updating' || state === 'queued' ? <Loader className="size-3 animate-spin" /> : <CircleFadingArrowUp className="size-3" />}
            {state === 'outdated' ? 'Update' : UPDATE_STATE_LABEL[state!]}
          </PopoverTrigger>
          <PopoverContent className="w-80 text-dense">
            <div className="grid gap-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">Agent update</span>
                <UpdateStateBadge state={state!} />
              </div>
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-micro">
                <dt className="text-muted-foreground">Installed</dt>
                <dd className="truncate font-mono">{formatAgentVersion(version)}</dd>
                <dt className="text-muted-foreground">Latest</dt>
                <dd className="truncate font-mono">{formatAgentVersion(data.latest_version)}</dd>
                <dt className="text-muted-foreground">Automatic</dt>
                <dd>
                  {data.auto_update ? 'On' : 'Off'}
                  <span className="text-subtle-foreground"> · {data.auto_update_policy ?? 'default'}</span>
                </dd>
              </dl>
              {data.last_error && <p className="rounded-md bg-critical/8 px-2 py-1.5 text-micro text-critical">{data.last_error}</p>}
              <div className="flex items-center justify-between gap-2">
                <Link to="/devices/updates" className="text-micro text-primary hover:underline">
                  All agent updates
                </Link>
                {canUpdate && canUpdateNow(state!) && (
                  <Button size="sm" disabled={update.isPending} onClick={() => update.mutate()}>
                    {update.isPending ? <Spinner data-icon="inline-start" /> : <CircleFadingArrowUp data-icon="inline-start" />}
                    Update now
                  </Button>
                )}
              </div>
            </div>
          </PopoverContent>
        </Popover>
      )}
    </span>
  )
}
