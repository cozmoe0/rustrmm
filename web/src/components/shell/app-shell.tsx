import { useEffect, type ReactNode } from 'react'
import { stream } from '@/lib/api/stream'
import { RunDialogHost } from '@/features/automation/run-dialog'
import { useAutomationLive } from '@/features/automation/use-automation-live'
import { useMonitoringLive } from '@/features/monitoring/use-monitoring-live'
import { usePatchingLive } from '@/features/patching/use-patching-live'
import { DeployDialogHost } from '@/features/software/deploy-dialog'
import { NewTicketDialogHost } from '@/features/tickets/new-ticket-dialog'
import { LogTimeDialogHost } from '@/features/tickets/ticket-time'
import { useTicketsLive } from '@/features/tickets/use-tickets-live'
import { CommandPalette } from './command-palette'
import { CommandRail } from './command-rail'
import { FleetPulse } from './fleet-pulse'
import { GlobalHotkeys } from './global-hotkeys'
import { MobileNav } from './mobile-nav'
import { ShortcutsDialog } from './shortcuts-dialog'
import { TopBar } from './top-bar'
import { WorkspaceTabs } from './workspace-tabs'

/** The authenticated application frame: Command Rail, top bar, Fleet Pulse, workspace tabs. */
export function AppShell({ children }: { children: ReactNode }) {
  useEffect(() => {
    stream.start()
    return () => stream.stop()
  }, [])
  useAutomationLive()
  useMonitoringLive()
  usePatchingLive()
  useTicketsLive()

  return (
    <div className="flex h-dvh overflow-hidden bg-background">
      <a
        href="#main"
        className="sr-only z-50 rounded-md bg-primary px-3 py-2 text-primary-foreground focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        Skip to content
      </a>
      <CommandRail />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <FleetPulse />
        <WorkspaceTabs />
        <main id="main" className="relative min-h-0 flex-1 overflow-hidden">
          {children}
        </main>
      </div>
      <MobileNav />
      <CommandPalette />
      <RunDialogHost />
      <DeployDialogHost />
      <NewTicketDialogHost />
      <LogTimeDialogHost />
      <ShortcutsDialog />
      <GlobalHotkeys />
    </div>
  )
}

/** A scrollable page region inside the shell. */
export function ScrollPage({ children }: { children: ReactNode }) {
  return <div className="h-full overflow-y-auto">{children}</div>
}
