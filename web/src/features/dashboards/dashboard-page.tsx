/*
 * Home and saved dashboards. Home shows `GET /dashboards/default` (the built-in layout until the
 * user picks one) with the greeting, onboarding, clients and platform cards around it; any
 * dashboard can be edited (owner, or `reports.manage` for shared ones), duplicated or made Home.
 */
import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { Check, ChevronDown, Copy, House, LayoutDashboard, Pencil, Plus, Share2, Star, StarOff, Trash, Users } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { EmptyState } from '@/components/common/empty-state'
import { ErrorState } from '@/components/common/misc'
import { PageContainer, SectionTitle } from '@/components/common/page-header'
import { Can } from '@/components/common/can'
import { dashboardsApi } from '@/lib/api/endpoints'
import { errorMessage } from '@/lib/api/errors'
import { dashboardQuery, dashboardsQuery, homeDashboardQuery, platformKeys } from '@/lib/api/queries'
import type { Dashboard, DashboardInput, WidgetName, WidgetPlacement } from '@/lib/api/types'
import { MAX_WIDGETS, addItem, layoutIssues, removeItem } from '@/lib/dashboards/grid'
import { BUILTIN_HOME_ID, BUILTIN_HOME_LAYOUT, WIDGET_BY_NAME } from '@/lib/dashboards/widgets'
import { PERMISSIONS, hasGlobalPermission, hasPermission, useMe } from '@/lib/permissions'
import { useTitle } from '@/lib/use-title'
import { cn } from '@/lib/utils'
import { UnsavedChangesGuard } from '@/features/automation/unsaved-guard'
import { ClientGrid, OnboardingChecklist, RecentActivity, SystemCard } from '@/features/home/home-page'
import { SecurityNetworkCard } from '@/features/home/security-network-card'
import { DashboardGrid } from './dashboard-grid'
import { WidgetPicker, WidgetSettings } from './widget-editors'
import { WidgetFrame } from './widget-frame'

function greeting() {
  const hour = new Date().getHours()
  if (hour < 5) return 'Working late'
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  return 'Good evening'
}

interface Draft {
  name: string
  shared: boolean
  layout: WidgetPlacement[]
}

const body = (dashboard: Pick<Dashboard, 'name' | 'shared' | 'layout'>, patch: Partial<DashboardInput> = {}): DashboardInput => ({ name: dashboard.name, shared: dashboard.shared, layout: dashboard.layout, ...patch })

function useDashboardMutations() {
  const queryClient = useQueryClient()
  const refresh = () => void queryClient.invalidateQueries({ queryKey: platformKeys.dashboards })
  return { refresh }
}

function Switcher({ current, onHome }: { current: Dashboard | undefined; onHome: boolean }) {
  const { data } = useQuery(dashboardsQuery)
  const mine = (data?.items ?? []).filter((item) => !item.shared)
  const shared = (data?.items ?? []).filter((item) => item.shared)
  const entry = (item: Dashboard) => (
    <DropdownMenuItem key={item.id} render={<Link to="/dashboards/$dashboardId" params={{ dashboardId: item.id }} />}>
      {item.shared ? <Users /> : <LayoutDashboard />}
      <span className="min-w-0 flex-1 truncate">{item.name}</span>
      {item.is_default && <Star className="text-primary" />}
      {current?.id === item.id && !onHome && <Check />}
    </DropdownMenuItem>
  )
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="outline" size="sm" className="max-w-full" />}>
        {onHome ? <House data-icon="inline-start" /> : current?.shared ? <Users data-icon="inline-start" /> : <LayoutDashboard data-icon="inline-start" />}
        <span className="max-w-48 truncate">{onHome ? 'Home' : (current?.name ?? 'Dashboard')}</span>
        <ChevronDown data-icon="inline-end" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuItem render={<Link to="/" />}>
          <House />
          <span className="flex-1">Home</span>
          {onHome && <Check />}
        </DropdownMenuItem>
        {mine.length > 0 && (
          <DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>My dashboards</DropdownMenuLabel>
            {mine.map(entry)}
          </DropdownMenuGroup>
        )}
        {shared.length > 0 && (
          <DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Shared</DropdownMenuLabel>
            {shared.map(entry)}
          </DropdownMenuGroup>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function DashboardPage({ dashboardId, editing }: { dashboardId: string | null; editing: boolean }) {
  const me = useMe()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { refresh } = useDashboardMutations()
  const onHome = dashboardId === null
  const home = useQuery({ ...homeDashboardQuery, enabled: onHome })
  const saved = useQuery({ ...dashboardQuery(dashboardId ?? ''), enabled: !onHome })
  const query = onHome ? home : saved
  const dashboard = query.data
  const builtin = dashboard?.id === BUILTIN_HOME_ID
  const canShare = hasPermission(me, PERMISSIONS.reportsManage)
  const [deleting, setDeleting] = useState(false)
  useTitle(onHome ? 'Home' : (dashboard?.name ?? 'Dashboard'))

  const go = (id: string, edit = false) => void navigate({ to: '/dashboards/$dashboardId', params: { dashboardId: id }, search: edit ? { edit: true } : {} })

  const create = useMutation({
    mutationFn: (input: DashboardInput) => dashboardsApi.create(input),
    meta: { silent: true },
    onSuccess: (created) => {
      refresh()
      if (created.is_default) void queryClient.invalidateQueries({ queryKey: platformKeys.home })
      go(created.id, true)
    },
    onError: (failure) => toast.error(errorMessage(failure)),
  })
  const setDefault = useMutation({
    mutationFn: ({ target, value }: { target: Dashboard; value: boolean }) => dashboardsApi.update(target.id, body(target, { is_default: value })),
    meta: { silent: true },
    onSuccess: (updated, { value }) => {
      toast.success(value ? `“${updated.name}” is now your Home` : 'Home is back to the built-in layout')
      refresh()
      void queryClient.invalidateQueries({ queryKey: platformKeys.home })
    },
    onError: (failure) => toast.error(errorMessage(failure)),
  })
  const remove = useMutation({
    mutationFn: (target: Dashboard) => dashboardsApi.remove(target.id),
    meta: { silent: true },
    onSuccess: (_result, target) => {
      toast.success(`Deleted “${target.name}”`)
      setDeleting(false)
      refresh()
      void queryClient.invalidateQueries({ queryKey: platformKeys.home })
      void navigate({ to: '/' })
    },
    onError: (failure) => toast.error(errorMessage(failure)),
  })

  const customize = () => {
    if (!dashboard) return
    create.mutate({ name: builtin ? 'My Home' : `${dashboard.name} (copy)`, shared: false, layout: dashboard.layout, is_default: builtin || (onHome && dashboard.is_default) })
  }
  const startEdit = () => {
    if (!dashboard) return
    if (!dashboard.editable) customize()
    else if (onHome) go(dashboard.id, true)
    else void navigate({ to: '.', search: { edit: true } })
  }

  if (editing && dashboard && dashboard.editable) {
    return <DashboardEditor key={`${dashboard.id}-${dashboard.updated_at}`} dashboard={dashboard} canShare={canShare} onDone={() => void navigate({ to: '.', search: {} })} />
  }

  const firstName = me?.user.name.split(' ')[0] ?? ''
  const layout = dashboard?.layout ?? (onHome ? BUILTIN_HOME_LAYOUT : [])

  return (
    <div className="h-full overflow-y-auto">
      <PageContainer className="grid gap-6">
        <div className="flex flex-col justify-between gap-3 lg:flex-row lg:items-end">
          {onHome ? (
            <div className="min-w-0">
              <p className="eyebrow mb-1">{me?.organization.name}</p>
              <h1 className="font-display text-[24px] leading-tight font-semibold tracking-tight">
                {greeting()}, {firstName}
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">
                {new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date())} · {builtin ? 'Here’s the state of your fleet.' : `Showing “${dashboard?.name ?? '…'}”.`}
              </p>
            </div>
          ) : (
            <div className="min-w-0">
              <p className="eyebrow mb-1 flex items-center gap-1.5">
                {dashboard?.shared ? <Users className="size-3" /> : <LayoutDashboard className="size-3" />}
                {dashboard?.shared ? `Shared dashboard${dashboard.owner_name ? ` · ${dashboard.owner_name}` : ''}` : 'My dashboard'}
              </p>
              <h1 className="font-display flex items-center gap-2 truncate text-[22px] leading-tight font-semibold">
                {dashboard?.name ?? <Skeleton className="h-6 w-48" />}
                {dashboard?.is_default && (
                  <Badge variant="default">
                    <Star />
                    Home
                  </Badge>
                )}
              </h1>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Switcher current={dashboard} onHome={onHome} />
            <Button variant="outline" size="sm" onClick={startEdit} disabled={!dashboard || create.isPending}>
              {create.isPending ? <Spinner data-icon="inline-start" /> : <Pencil data-icon="inline-start" />}
              {dashboard?.editable ? 'Edit' : 'Customize'}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="More dashboard actions" disabled={!dashboard} />}>
                <ChevronDown />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuItem onClick={() => create.mutate({ name: 'Untitled dashboard', shared: false, layout: [] })}>
                  <Plus />
                  New dashboard
                </DropdownMenuItem>
                {dashboard && (
                  <DropdownMenuItem onClick={() => create.mutate({ name: builtin ? 'My Home' : `${dashboard.name} (copy)`, shared: false, layout: dashboard.layout })}>
                    <Copy />
                    Duplicate
                  </DropdownMenuItem>
                )}
                {dashboard && !builtin && (
                  <>
                    <DropdownMenuSeparator />
                    {dashboard.is_default ? (
                      <DropdownMenuItem onClick={() => setDefault.mutate({ target: dashboard, value: false })}>
                        <StarOff />
                        Use the built-in Home
                      </DropdownMenuItem>
                    ) : (
                      <DropdownMenuItem onClick={() => setDefault.mutate({ target: dashboard, value: true })}>
                        <Star />
                        Set as my Home
                      </DropdownMenuItem>
                    )}
                    {dashboard.editable && (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem variant="destructive" onClick={() => setDeleting(true)}>
                          <Trash />
                          Delete dashboard
                        </DropdownMenuItem>
                      </>
                    )}
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {onHome && <SetupStrip />}

        {query.error ? (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        ) : query.isLoading ? (
          <div className="grid gap-3 sm:grid-cols-3">
            {Array.from({ length: 6 }, (_, index) => (
              <Skeleton key={index} className={cn('h-44 rounded-xl', index === 3 && 'sm:col-span-2')} />
            ))}
          </div>
        ) : layout.length === 0 ? (
          <EmptyState
            illustration="launch"
            title="This dashboard is empty"
            description={dashboard?.editable ? 'Add widgets for fleet health, alerts, patching, tickets and more.' : 'Its owner hasn’t added any widgets yet.'}
            actions={
              dashboard?.editable && (
                <Button size="sm" onClick={startEdit}>
                  <Plus data-icon="inline-start" />
                  Add widgets
                </Button>
              )
            }
          />
        ) : (
          <DashboardGrid layout={layout} editing={false} renderItem={(item) => <WidgetFrame item={item} editing={false} />} />
        )}

        {onHome && (
          <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
            <section className="grid min-w-0 content-start gap-3">
              <SectionTitle
                description="Health, alerts, tickets and patch compliance per client."
                actions={
                  <Link to="/clients" className="text-dense text-muted-foreground hover:text-foreground">
                    All clients
                  </Link>
                }
              >
                Clients
              </SectionTitle>
              <ClientGrid />
            </section>
            <aside className="grid min-w-0 content-start gap-4">
              <SecurityNetworkCard />
              <Can permission={PERMISSIONS.auditView}>
                <RecentActivity />
              </Can>
              {hasGlobalPermission(me, PERMISSIONS.settingsView) && <SystemCard />}
            </aside>
          </div>
        )}
      </PageContainer>
      {dashboard && !builtin && (
        <ConfirmDialog
          open={deleting}
          onOpenChange={setDeleting}
          title={`Delete “${dashboard.name}”?`}
          description={dashboard.shared ? 'Everyone loses this shared dashboard; anyone using it as Home goes back to the built-in layout.' : 'This dashboard is removed. If it is your Home, Home goes back to the built-in layout.'}
          pending={remove.isPending}
          onConfirm={() => remove.mutate(dashboard)}
        />
      )}
    </div>
  )
}

/** The onboarding checklist, only while setup is incomplete (it hides itself once done). */
function SetupStrip() {
  const [hidden, setHidden] = useState(() => {
    try {
      return window.localStorage.getItem('rustrmm.home.setup-hidden') === '1'
    } catch {
      return false
    }
  })
  if (hidden) return null
  return (
    <div className="relative">
      <OnboardingChecklist compact onHide={() => {
        setHidden(true)
        try {
          window.localStorage.setItem('rustrmm.home.setup-hidden', '1')
        } catch {
          // Storage may be unavailable; hiding still applies for this visit.
        }
      }} />
    </div>
  )
}

function DashboardEditor({ dashboard, canShare, onDone }: { dashboard: Dashboard; canShare: boolean; onDone: () => void }) {
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState<Draft>({ name: dashboard.name, shared: dashboard.shared, layout: dashboard.layout })
  const [picking, setPicking] = useState(false)
  const [configuring, setConfiguring] = useState<number | null>(null)
  const [selected, setSelected] = useState<number | null>(null)
  const dirty = draft.name !== dashboard.name || draft.shared !== dashboard.shared || JSON.stringify(draft.layout) !== JSON.stringify(dashboard.layout)
  const issues = useMemo(() => [...(draft.name.trim() ? [] : ['Give the dashboard a name']), ...layoutIssues(draft.layout)], [draft])
  const full = draft.layout.length >= MAX_WIDGETS

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.key === 'Delete' || event.key === 'Backspace') && selected !== null && document.activeElement?.getAttribute('aria-roledescription') === 'Movable widget') {
        event.preventDefault()
        setDraft((prev) => ({ ...prev, layout: removeItem(prev.layout, selected) }))
        setSelected(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selected])

  const save = useMutation({
    mutationFn: () => dashboardsApi.update(dashboard.id, { name: draft.name.trim(), shared: draft.shared, layout: draft.layout, is_default: dashboard.is_default }),
    meta: { silent: true },
    onSuccess: (updated) => {
      toast.success(`Saved “${updated.name}”`)
      queryClient.setQueryData(platformKeys.dashboard(updated.id), updated)
      void queryClient.invalidateQueries({ queryKey: platformKeys.dashboards })
      onDone()
    },
    onError: (failure) => toast.error(errorMessage(failure)),
  })

  const add = (widget: WidgetName) => {
    const def = WIDGET_BY_NAME[widget]
    setDraft((prev) => ({ ...prev, layout: addItem(prev.layout, { widget, w: def.defaultSize.w, h: def.defaultSize.h, config: def.defaultLimit ? { limit: def.defaultLimit } : {} }) }))
    setPicking(false)
    if (def.settings.includes('field')) setConfiguring(draft.layout.length)
    toast.success(`Added ${def.label}`)
  }

  return (
    <div className="flex h-full flex-col">
      <UnsavedChangesGuard when={dirty && !save.isSuccess} what="dashboard changes" />
      <div className="sticky top-0 z-30 flex flex-wrap items-center gap-2 border-b border-border bg-surface-1/95 px-4 py-2.5 backdrop-blur sm:px-6">
        <Label htmlFor="dashboard-name" className="sr-only">
          Dashboard name
        </Label>
        <Input id="dashboard-name" value={draft.name} onChange={(event) => setDraft((prev) => ({ ...prev, name: event.target.value }))} maxLength={80} className="h-8 w-full min-w-0 font-medium sm:w-64" aria-invalid={!draft.name.trim() || undefined} />
        {canShare && (
          <label className="flex items-center gap-2 rounded-md px-2 text-dense text-muted-foreground">
            <Switch checked={draft.shared} onCheckedChange={(shared) => setDraft((prev) => ({ ...prev, shared }))} aria-label="Share with everyone who can view reports" />
            <Share2 className="size-3.5" />
            Shared
          </label>
        )}
        <span className="tabular text-micro text-subtle-foreground">
          {draft.layout.length}/{MAX_WIDGETS} widgets
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setPicking(true)} disabled={full}>
            <Plus data-icon="inline-start" />
            Add widget
          </Button>
          <Button variant="ghost" size="sm" onClick={onDone}>
            {dirty ? 'Discard' : 'Done'}
          </Button>
          <Button size="sm" onClick={() => save.mutate()} disabled={!dirty || issues.length > 0 || save.isPending}>
            {save.isPending ? <Spinner data-icon="inline-start" /> : <Check data-icon="inline-start" />}
            Save
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <PageContainer className="grid gap-4">
          <p className="text-dense text-muted-foreground">
            Drag a widget by its header and resize it from the corner, or focus it and use the arrow keys (Shift + arrows resizes, Delete removes). Widgets re-flow to fill the space above them.
            {draft.shared && ' Shared dashboards are visible to everyone with “View reports”.'}
          </p>
          {issues.length > 0 && (
            <ul className="rounded-lg bg-critical/[0.06] px-3 py-2 text-dense text-critical ring-1 ring-critical/25">
              {issues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          )}
          {draft.layout.length === 0 ? (
            <EmptyState
              illustration="launch"
              title="Start with a widget"
              description="Pick from fleet health, alerts, patch compliance, tickets, SLA breaches, offline devices and more."
              actions={
                <Button size="sm" onClick={() => setPicking(true)}>
                  <Plus data-icon="inline-start" />
                  Add widget
                </Button>
              }
            />
          ) : (
            <DashboardGrid
              layout={draft.layout}
              editing
              selected={selected}
              onSelect={setSelected}
              onChange={(layout) => setDraft((prev) => ({ ...prev, layout }))}
              renderItem={(item, index) => (
                <WidgetFrame
                  item={item}
                  editing
                  onConfigure={() => setConfiguring(index)}
                  onRemove={() => {
                    setDraft((prev) => ({ ...prev, layout: removeItem(prev.layout, index) }))
                    setSelected(null)
                  }}
                />
              )}
            />
          )}
        </PageContainer>
      </div>
      <WidgetPicker open={picking} onOpenChange={setPicking} onPick={add} used={draft.layout.map((item) => item.widget)} full={full} />
      <WidgetSettings
        widget={configuring !== null ? (draft.layout[configuring]?.widget ?? null) : null}
        config={configuring !== null ? (draft.layout[configuring]?.config ?? {}) : {}}
        open={configuring !== null && Boolean(draft.layout[configuring])}
        onOpenChange={(open) => !open && setConfiguring(null)}
        onSave={(config) => {
          setDraft((prev) => ({ ...prev, layout: prev.layout.map((item, index) => (index === configuring ? { ...item, config } : item)) }))
          setConfiguring(null)
        }}
      />
    </div>
  )
}
