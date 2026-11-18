import type { ReactNode } from 'react'
import { Link, Outlet } from '@tanstack/react-router'
import {
  Activity,
  BellRing,
  BookOpenText,
  DatabaseBackup,
  FileBadge2,
  KeyRound,
  LifeBuoy,
  Palette,
  ScrollText,
  ShieldCheck,
  SlidersHorizontal,
  SquareArrowOutUpRight,
  UserCog,
  Users,
  Waypoints,
  Webhook,
} from 'lucide-react'
import { ContextGroup, ContextLink, ContextPanel } from '@/components/shell/context-panel'
import type { RoutePath } from '@/lib/nav'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'

interface Item {
  to: RoutePath
  label: string
  icon: ReactNode
}

export function SettingsLayout() {
  const me = useMe()
  const can = (permission: string) => hasPermission(me, permission)
  const global = Boolean(me?.scopes.global)
  // Installation-wide settings need the permission held globally.
  const canNotifications = can(PERMISSIONS.notificationsManage) && global
  const canSso = can(PERMISSIONS.settingsManage) && global
  const canWebhooks = can(PERMISSIONS.apiManage)

  const item = (to: RoutePath, label: string, icon: ReactNode): Item => ({ to, label, icon })
  const groups: { label: string; items: Item[] }[] = [
    {
      label: 'Team',
      items: can(PERMISSIONS.usersView)
        ? [
            item('/settings/users', 'Users', <Users />),
            item('/settings/roles', 'Roles & permissions', <UserCog />),
          ]
        : [],
    },
    {
      label: 'Account',
      items: [
        item('/settings/security', 'My security', <ShieldCheck />),
        item('/settings/api-tokens', 'API tokens', <KeyRound />),
      ],
    },
    {
      label: 'Platform',
      items: [
        item('/settings/custom-fields', 'Custom fields', <SlidersHorizontal />),
        ...(can(PERMISSIONS.backupsView) ? [item('/settings/backups', 'Backups', <DatabaseBackup />)] : []),
        ...(can(PERMISSIONS.auditView) ? [item('/settings/audit', 'Audit log', <ScrollText />)] : []),
      ],
    },
    {
      label: 'Access & integrations',
      items: [
        ...(canSso ? [item('/settings/sso', 'Single sign-on', <Waypoints />)] : []),
        ...(canWebhooks ? [item('/settings/webhooks', 'Webhooks', <Webhook />)] : []),
      ],
    },
    {
      label: 'Monitoring',
      items: [
        ...(canNotifications ? [item('/settings/notifications', 'Notifications', <BellRing />)] : []),
        ...(can(PERMISSIONS.settingsView) ? [item('/settings/monitoring', 'Monitoring', <Activity />)] : []),
      ],
    },
    {
      label: 'Helpdesk',
      items:
        can(PERMISSIONS.ticketsSettings) || can(PERMISSIONS.ticketsManage)
          ? [item('/settings/tickets', can(PERMISSIONS.ticketsSettings) && global ? 'Helpdesk' : 'Canned responses', <LifeBuoy />)]
          : [],
    },
    {
      label: 'White label & trust',
      items: [
        ...(can(PERMISSIONS.settingsView) ? [item('/settings/branding', 'Branding', <Palette />)] : []),
        // The signing status reads the agent bundle on the server: settings.manage installation-wide.
        ...(can(PERMISSIONS.settingsManage) && global ? [item('/settings/signing', 'Code signing', <FileBadge2 />)] : []),
      ],
    },
  ].filter((group) => group.items.length > 0)
  const all = groups.flatMap((group) => group.items)

  return (
    <div className="flex h-full">
      <ContextPanel
        section="settings"
        title="Settings"
        footer={
          <a href="/api/docs" target="_blank" rel="noopener" className="flex h-8 items-center gap-2.5 rounded-md px-2 text-dense text-muted-foreground outline-none hover:bg-surface-3 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-4 [&_svg]:text-subtle-foreground">
            <BookOpenText />
            API documentation
            <SquareArrowOutUpRight className="ml-auto size-3!" />
          </a>
        }
      >
        {groups.map((group) => (
          <ContextGroup key={group.label} label={group.label}>
            {group.items.map((item) => (
              <ContextLink key={item.to} to={item.to} icon={item.icon}>
                {item.label}
              </ContextLink>
            ))}
          </ContextGroup>
        ))}
      </ContextPanel>
      <div className="flex min-w-0 flex-1 flex-col">
        <nav aria-label="Settings sections" className="flex shrink-0 [scrollbar-width:none] gap-1 overflow-x-auto border-b border-border bg-surface-1/60 px-3 py-2 md:hidden">
          {all.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              activeOptions={{ includeSearch: false }}
              className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-dense text-muted-foreground outline-none hover:bg-surface-3 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[status=active]:bg-surface-3 data-[status=active]:font-medium data-[status=active]:text-foreground [&_svg]:size-3.5"
            >
              {item.icon}
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <Outlet />
        </div>
      </div>
    </div>
  )
}
