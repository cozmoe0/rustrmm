import { useLocation, useNavigate } from '@tanstack/react-router'
import { Building, MonitorSmartphone, Ticket, Workflow, X } from 'lucide-react'
import { closeWorkspaceTab, tabHref, useWorkspaceTabs, type WorkspaceTab } from '@/lib/workspace'
import { EntityAvatar } from '@/components/common/misc'
import { OsIcon } from '@/components/common/os-icon'
import { cn } from '@/lib/utils'

const ICONS = { client: Building, device: MonitorSmartphone, ticket: Ticket, job: Workflow }

export function WorkspaceTabs() {
  const tabs = useWorkspaceTabs()
  const { pathname } = useLocation()
  const navigate = useNavigate()

  if (tabs.length === 0) return null

  function go(tab: WorkspaceTab) {
    // Tabs are persisted as plain strings, so the typed router path is asserted here.
    void navigate({ to: tab.to as never, params: tab.params as never })
  }

  function close(tab: WorkspaceTab, index: number) {
    const active = pathname === tabHref(tab)
    closeWorkspaceTab(tab.id)
    if (active) {
      const neighbour = tabs[index + 1] ?? tabs[index - 1]
      if (neighbour && neighbour.id !== tab.id) go(neighbour)
      else void navigate({ to: tab.kind === 'client' ? '/clients' : tab.kind === 'device' ? '/devices' : '/' })
    }
  }

  return (
    <div
      role="tablist"
      aria-label="Open workspace items"
      className="flex h-[34px] shrink-0 items-end gap-1 overflow-x-auto border-b border-border bg-surface-1/40 px-2 [scrollbar-width:none] sm:px-3"
    >
      {tabs.map((tab, index) => {
        const active = pathname === tabHref(tab)
        const Icon = ICONS[tab.kind]
        return (
          <div
            key={tab.id}
            role="tab"
            tabIndex={0}
            aria-selected={active}
            title={index < 9 ? `${tab.title} (Ctrl+${index + 1})` : tab.title}
            onClick={() => go(tab)}
            onAuxClick={(event) => {
              if (event.button === 1) {
                event.preventDefault()
                close(tab, index)
              }
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                go(tab)
              } else if (event.key === 'Delete') {
                close(tab, index)
              }
            }}
            className={cn(
              'group relative flex h-[28px] max-w-52 min-w-0 shrink-0 cursor-pointer items-center gap-1.5 rounded-t-md border border-b-0 px-2 text-dense outline-none select-none focus-visible:ring-2 focus-visible:ring-ring',
              active
                ? 'border-border bg-background text-foreground after:absolute after:inset-x-0 after:-bottom-px after:h-px after:bg-background'
                : 'border-transparent text-muted-foreground hover:bg-surface-3/60 hover:text-foreground',
            )}
          >
            {active && <span className="absolute inset-x-2 top-0 h-[2px] rounded-b-full bg-primary" />}
            {tab.kind === 'client' ? (
              <EntityAvatar name={tab.title} seed={tab.params?.clientId ?? tab.id} accent={tab.accent} size="xs" />
            ) : tab.kind === 'device' && (tab.meta?.os === 'windows' || tab.meta?.os === 'macos' || tab.meta?.os === 'linux') ? (
              <OsIcon family={tab.meta.os} />
            ) : (
              <Icon className="size-3.5 shrink-0" />
            )}
            <span className="truncate">{tab.title}</span>
            {index < 9 && (
              <span className="hidden font-mono text-[10px] text-subtle-foreground group-hover:inline">{index + 1}</span>
            )}
            <button
              type="button"
              aria-label={`Close ${tab.title}`}
              onClick={(event) => {
                event.stopPropagation()
                close(tab, index)
              }}
              className={cn(
                'ml-0.5 flex size-4 shrink-0 items-center justify-center rounded-sm text-subtle-foreground hover:bg-surface-4 hover:text-foreground',
                active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
              )}
            >
              <X className="size-3" />
            </button>
          </div>
        )
      })}
    </div>
  )
}
