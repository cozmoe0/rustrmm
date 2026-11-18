/* Helpdesk settings: queues, SLA policies, canned responses, email and alert-to-ticket rules. */
import { useNavigate } from '@tanstack/react-router'
import { LifeBuoy } from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { EmptyState } from '@/components/common/empty-state'
import { PageContainer, PageHeader } from '@/components/common/page-header'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'
import { useTitle } from '@/lib/use-title'
import { CannedTab } from './canned-tab'
import { EmailTab } from './email-tab'
import { QueuesTab } from './queues-tab'
import { RulesTab } from './rules-tab'
import { SlaTab } from './sla-tab'

export type SettingsTab = 'queues' | 'sla' | 'canned' | 'email' | 'rules'

const TABS: { value: SettingsTab; label: string }[] = [
  { value: 'queues', label: 'Queues' },
  { value: 'sla', label: 'SLA policies' },
  { value: 'canned', label: 'Canned responses' },
  { value: 'email', label: 'Email' },
  { value: 'rules', label: 'Alert rules' },
]

export function TicketSettingsPage({ tab }: { tab: SettingsTab }) {
  useTitle('Helpdesk settings')
  const me = useMe()
  const navigate = useNavigate()
  const canSettings = hasPermission(me, PERMISSIONS.ticketsSettings)
  const canManage = hasPermission(me, PERMISSIONS.ticketsManage)
  // Installation-wide objects need the permission globally; private canned responses only need tickets.manage.
  const global = canSettings && Boolean(me?.scopes.global)

  if (!canSettings && !canManage) {
    return (
      <PageContainer>
        <EmptyState illustration="tickets" title="You can’t change helpdesk settings" description="Ask an administrator for the “Helpdesk settings” permission." />
      </PageContainer>
    )
  }
  const visible = global ? TABS : TABS.filter((item) => item.value === 'canned')
  const current = visible.some((item) => item.value === tab) ? tab : visible[0].value

  return (
    <PageContainer className="grid gap-5">
      <PageHeader icon={<LifeBuoy />} title="Helpdesk" description="How tickets are routed, timed, answered and created from email and alerts." />
      <Tabs value={current} onValueChange={(value) => void navigate({ to: '/settings/tickets', search: { tab: value as SettingsTab }, replace: true })} className="gap-5">
        <div className="-mx-4 overflow-x-auto border-b border-border px-4 [scrollbar-width:none] sm:-mx-6 sm:px-6">
          <TabsList variant="line" className="-mb-px h-10 w-max gap-5">
            {visible.map((item) => (
              <TabsTrigger key={item.value} value={item.value} className="flex-none px-0">
                {item.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        {global && (
          <TabsContent value="queues">
            <QueuesTab />
          </TabsContent>
        )}
        {global && (
          <TabsContent value="sla">
            <SlaTab />
          </TabsContent>
        )}
        <TabsContent value="canned">
          <CannedTab />
        </TabsContent>
        {global && (
          <TabsContent value="email">
            <EmailTab />
          </TabsContent>
        )}
        {global && (
          <TabsContent value="rules">
            <RulesTab />
          </TabsContent>
        )}
      </Tabs>
    </PageContainer>
  )
}
