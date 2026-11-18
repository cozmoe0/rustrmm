import { useMutation, useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query'
import { toast } from 'sonner'
import { alertsApi } from '@/lib/api/endpoints'
import { errorMessage } from '@/lib/api/errors'
import { keys, usersQuery } from '@/lib/api/queries'
import type { Alert, AlertDetail, AlertListResponse } from '@/lib/api/types'
import { applyAlertAction, type ActionContext, type AlertAction } from '@/lib/monitoring/alerts'
import { applyBulk, bulkResultMessage, planBulk, type BulkAction } from '@/lib/monitoring/bulk'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'

type Patch = (alert: Alert) => Alert

/** Applies `patch` to every cached copy of the affected alerts (inbox pages, device lists, details). */
function patchCaches(queryClient: ReturnType<typeof useQueryClient>, ids: Set<string>, patch: Patch) {
  const apply = (alert: Alert) => (ids.has(alert.id) ? patch(alert) : alert)
  queryClient.setQueriesData<InfiniteData<AlertListResponse>>({ queryKey: [...keys.alerts, 'list'] }, (data) =>
    data?.pages ? { ...data, pages: data.pages.map((page) => ({ ...page, items: page.items.map(apply) })) } : data,
  )
  queryClient.setQueriesData<AlertListResponse>({ queryKey: [...keys.alerts, 'device'] }, (data) =>
    data ? { ...data, items: data.items.map(apply) } : data,
  )
  for (const id of ids) {
    queryClient.setQueryData<AlertDetail>(keys.alert(id), (detail) => (detail ? { ...detail, alert: patch(detail.alert) } : detail))
  }
}

function refresh(queryClient: ReturnType<typeof useQueryClient>, ids: string[]) {
  void queryClient.invalidateQueries({ queryKey: [...keys.alerts, 'list'] })
  void queryClient.invalidateQueries({ queryKey: [...keys.alerts, 'device'] })
  void queryClient.invalidateQueries({ queryKey: keys.alertsSummary })
  void queryClient.invalidateQueries({ queryKey: [...keys.alerts, 'counts'] })
  void queryClient.invalidateQueries({ queryKey: ['fleet'] })
  for (const id of ids) void queryClient.invalidateQueries({ queryKey: keys.alert(id) })
}

const DONE: Record<AlertAction['action'], string> = {
  acknowledge: 'Acknowledged',
  unacknowledge: 'Acknowledgement removed',
  resolve: 'Resolved',
  snooze: 'Snoozed',
  assign: 'Assignment updated',
}

/** Alert actions with optimistic updates, server reconciliation and toasts (with undo for acknowledge). */
export function useAlertActions() {
  const queryClient = useQueryClient()
  const me = useMe()
  const { data: users = [] } = useQuery({ ...usersQuery, enabled: hasPermission(me, PERMISSIONS.usersView), meta: { silent: true } })
  const canManage = hasPermission(me, PERMISSIONS.alertsManage)
  const context = (): ActionContext => ({
    actor: { id: me?.user.id ?? '', name: me?.user.name ?? 'You' },
    userName: (id) => users.find((user) => user.id === id)?.name,
  })

  const single = useMutation({
    mutationFn: async ({ alert, change, note }: { alert: Alert; change: AlertAction; note?: string; quiet?: boolean }) => {
      switch (change.action) {
        case 'acknowledge':
          return (await alertsApi.acknowledge(alert.id, note)).alert
        case 'unacknowledge':
          return (await alertsApi.unacknowledge(alert.id)).alert
        case 'resolve':
          return (await alertsApi.resolve(alert.id, note)).alert
        case 'snooze':
          return (await alertsApi.snooze(alert.id, change.until ? { until: change.until } : { minutes: change.minutes ?? 60 })).alert
        case 'assign':
          return (await alertsApi.assign(alert.id, change.user_id)).alert
      }
    },
    meta: { silent: true },
    onMutate: ({ alert, change }) => {
      const ctx = context()
      patchCaches(queryClient, new Set([alert.id]), (item) => applyAlertAction(item, change, ctx))
    },
    onSuccess: (updated, { alert, change, quiet }) => {
      if (updated) patchCaches(queryClient, new Set([alert.id]), () => updated)
      refresh(queryClient, [alert.id])
      if (quiet) return
      if (change.action === 'acknowledge') {
        toast.success(DONE.acknowledge, {
          description: alert.title,
          action: { label: 'Undo', onClick: () => single.mutate({ alert: updated ?? alert, change: { action: 'unacknowledge' }, quiet: true }) },
        })
      } else {
        toast.success(DONE[change.action], { description: alert.title })
      }
    },
    onError: (failure, { alert }) => {
      refresh(queryClient, [alert.id])
      toast.error(errorMessage(failure))
    },
  })

  const bulk = useMutation({
    mutationFn: async ({ selected, change }: { selected: Alert[]; change: BulkAction }) => {
      const plan = planBulk(selected, change)
      if (!plan.request) return { plan, result: null }
      return { plan, result: await alertsApi.bulk(plan.request) }
    },
    meta: { silent: true },
    onMutate: ({ selected, change }) => {
      const plan = planBulk(selected, change)
      if (!plan.request) return
      const request = plan.request
      const ctx = context()
      patchCaches(queryClient, new Set(plan.ids), (alert) => applyBulk([alert], request, ctx)[0])
    },
    onSuccess: ({ plan, result }, { selected, change }) => {
      refresh(queryClient, selected.map((alert) => alert.id))
      if (!result) {
        toast.info('Nothing to do', { description: 'The selected alerts are already in that state.' })
        return
      }
      const skipped = result.skipped + plan.skipped
      toast.success(bulkResultMessage(change.action, result.updated, skipped), {
        description: plan.overflow ? `${plan.overflow} more were left out: at most 500 per request.` : undefined,
      })
    },
    onError: (failure, { selected }) => {
      refresh(queryClient, selected.map((alert) => alert.id))
      toast.error(errorMessage(failure))
    },
  })

  return {
    canManage,
    users: users.filter((user) => user.status === 'active'),
    act: (alert: Alert, change: AlertAction, note?: string) => single.mutate({ alert, change, note }),
    bulk: (selected: Alert[], change: BulkAction) => bulk.mutate({ selected, change }),
    pending: single.isPending || bulk.isPending,
  }
}

/** Adds a note; the response refreshes the detail with the new event. */
export function useAddNote(alertId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (text: string) => alertsApi.addNote(alertId, text),
    meta: { successMessage: 'Note added' },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: keys.alert(alertId) }),
  })
}
