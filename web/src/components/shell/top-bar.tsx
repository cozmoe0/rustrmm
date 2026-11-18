import { Fragment } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useMatches, useNavigate } from '@tanstack/react-router'
import { Building, ChevronRight, DatabaseBackup, Menu, MapPin, Plus, Search, UserPlus } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Kbd } from '@/components/common/misc'
import { backupsApi } from '@/lib/api/endpoints'
import { clientQuery, deviceQuery, groupsQuery, jobQuery, keys, policyQuery, scriptQuery } from '@/lib/api/queries'
import { deviceName } from '@/lib/devices'
import { modKeyLabel } from '@/lib/hotkeys'
import { PERMISSIONS, useMe, hasPermission } from '@/lib/permissions'
import { useScope } from '@/lib/scope'
import { ClientSwitcher, SiteFilter } from './client-switcher'
import { mobileNavStore, paletteStore } from './ui-state'

/** Resolves a client's name reactively (the breadcrumb renders before the page's data arrives). */
function ClientCrumb({ clientId, fallback }: { clientId: string; fallback: string }) {
  const { data } = useQuery({ ...clientQuery(clientId), staleTime: 60_000 })
  return <>{data?.name ?? fallback}</>
}

function DeviceCrumb({ deviceId, fallback }: { deviceId: string; fallback: string }) {
  const { data } = useQuery({ ...deviceQuery(deviceId), staleTime: 60_000, refetchInterval: false })
  return <>{data ? deviceName(data) : fallback}</>
}

function ScriptCrumb({ scriptId, fallback }: { scriptId: string; fallback: string }) {
  const { data } = useQuery({ ...scriptQuery(scriptId), staleTime: 60_000 })
  return <>{data?.name ?? fallback}</>
}

function JobCrumb({ jobId, fallback }: { jobId: string; fallback: string }) {
  const { data } = useQuery({ ...jobQuery(jobId), staleTime: 60_000, refetchInterval: false })
  return <>{data?.name ?? fallback}</>
}

function GroupCrumb({ groupId, fallback }: { groupId: string; fallback: string }) {
  const { data } = useQuery({ ...groupsQuery(), staleTime: 60_000 })
  return <>{data?.find((group) => group.id === groupId)?.name ?? fallback}</>
}

function PolicyCrumb({ policyId, fallback }: { policyId: string; fallback: string }) {
  const { data } = useQuery({ ...policyQuery(policyId), staleTime: 60_000 })
  return <>{data?.name ?? fallback}</>
}

function Breadcrumbs() {
  const matches = useMatches()

  const crumbs = matches
    .filter((match) => match.staticData?.title)
    .map((match) => {
      const fallback = match.staticData.title as string
      const params = match.params as Record<string, string | undefined>
      const title =
        match.staticData.dynamicTitle === 'client' && params.clientId ? (
          <ClientCrumb clientId={params.clientId} fallback={fallback} />
        ) : match.staticData.dynamicTitle === 'device' && params.deviceId ? (
          <DeviceCrumb deviceId={params.deviceId} fallback={fallback} />
        ) : match.staticData.dynamicTitle === 'script' && params.scriptId ? (
          <ScriptCrumb scriptId={params.scriptId} fallback={fallback} />
        ) : match.staticData.dynamicTitle === 'job' && params.jobId ? (
          <JobCrumb jobId={params.jobId} fallback={fallback} />
        ) : match.staticData.dynamicTitle === 'group' && params.groupId ? (
          <GroupCrumb groupId={params.groupId} fallback={fallback} />
        ) : match.staticData.dynamicTitle === 'policy' && params.policyId ? (
          <PolicyCrumb policyId={params.policyId} fallback={fallback} />
        ) : (
          fallback
        )
      return { id: match.id, title, pathname: match.pathname }
    })

  if (crumbs.length === 0) return null

  return (
    <nav aria-label="Breadcrumb" className="hidden min-w-0 items-center gap-1 text-dense lg:flex">
      {crumbs.map((crumb, index) => {
        const last = index === crumbs.length - 1
        return (
          <Fragment key={crumb.id}>
            {index > 0 && <ChevronRight className="size-3.5 shrink-0 text-subtle-foreground" />}
            {last ? (
              <span aria-current="page" className="truncate font-medium text-foreground">
                {crumb.title}
              </span>
            ) : (
              <Link
                to={crumb.pathname}
                className="truncate text-muted-foreground hover:text-foreground"
              >
                {crumb.title}
              </Link>
            )}
          </Fragment>
        )
      })}
    </nav>
  )
}

function QuickCreate() {
  const me = useMe()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { clientId } = useScope()

  const canClients = hasPermission(me, PERMISSIONS.clientsManage)
  const canSites = hasPermission(me, PERMISSIONS.sitesManage)
  const canUsers = hasPermission(me, PERMISSIONS.usersManage)
  const canBackups = hasPermission(me, PERMISSIONS.backupsManage)
  if (!canClients && !canSites && !canUsers && !canBackups) return null

  async function runBackup() {
    try {
      await backupsApi.run()
      void queryClient.invalidateQueries({ queryKey: keys.backups })
      toast.success('Backup started')
      void navigate({ to: '/settings/backups' })
    } catch {
      // The mutation cache is not involved here; errors are shown by the toast below.
      toast.error('Could not start a backup')
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button size="sm" variant="outline" aria-label="Create new" />}>
        <Plus data-icon="inline-start" />
        <span className="hidden sm:inline">New</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Create</DropdownMenuLabel>
          {canClients && (
            <DropdownMenuItem onClick={() => void navigate({ to: '/clients', search: { new: true } })}>
              <Building />
              Client
            </DropdownMenuItem>
          )}
          {canSites && clientId && (
            <DropdownMenuItem
              onClick={() =>
                void navigate({
                  to: '/clients/$clientId',
                  params: { clientId },
                  search: { tab: 'sites', new: true },
                })
              }
            >
              <MapPin />
              Site for this client
            </DropdownMenuItem>
          )}
          {canUsers && (
            <DropdownMenuItem onClick={() => void navigate({ to: '/settings/users', search: { new: true } })}>
              <UserPlus />
              User
            </DropdownMenuItem>
          )}
          {canBackups && (
            <DropdownMenuItem onClick={() => void runBackup()}>
              <DatabaseBackup />
              Backup now
            </DropdownMenuItem>
          )}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function TopBar() {
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-surface-1/70 px-2 backdrop-blur-md sm:px-3">
      <Button
        variant="ghost"
        size="icon-sm"
        className="md:hidden"
        aria-label="Open navigation"
        onClick={() => mobileNavStore.set(true)}
      >
        <Menu />
      </Button>

      <ClientSwitcher />
      <SiteFilter className="hidden sm:flex" />
      <div className="mx-1 hidden h-5 w-px bg-border-strong lg:block" />
      <Breadcrumbs />

      <div className="ml-auto flex items-center gap-2">
        <button
          type="button"
          onClick={() => paletteStore.set(true)}
          className="group flex h-8 items-center gap-2 rounded-lg border border-border-strong bg-surface-1 px-2 text-dense text-muted-foreground outline-none transition-colors hover:border-input hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring sm:w-60 sm:px-2.5 dark:bg-white/[0.02]"
          aria-label="Search or run a command"
        >
          <Search className="size-4 shrink-0" />
          <span className="hidden flex-1 text-left sm:inline">Search or jump to…</span>
          <span className="hidden items-center gap-0.5 sm:flex">
            <Kbd>{modKeyLabel}</Kbd>
            <Kbd>K</Kbd>
          </span>
        </button>
        <QuickCreate />
      </div>
    </header>
  )
}
