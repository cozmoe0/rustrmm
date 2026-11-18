/* Settings › Notifications: channels, rules, the delivery log and the SMTP server. */
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { BellRing } from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ErrorState } from '@/components/common/misc'
import { PageContainer, PageHeader } from '@/components/common/page-header'
import { notificationChannelsQuery, notificationLogQuery, notificationRulesQuery } from '@/lib/api/queries'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'
import { useTitle } from '@/lib/use-title'
import { ChannelsTab } from './channels-tab'
import { DeliveryLogTab } from './delivery-log-tab'
import { RulesTab } from './rules-tab'
import { SmtpTab } from './smtp-tab'

export type NotificationsTab = 'channels' | 'rules' | 'log' | 'email'

function Count({ value, tone }: { value: number | undefined; tone?: 'critical' }) {
  if (!value) return null
  return (
    <span className={tone === 'critical' ? 'tabular rounded-full bg-critical/12 px-1.5 text-[10px] text-critical' : 'tabular text-micro text-subtle-foreground'}>
      {value}
    </span>
  )
}

export function NotificationsPage({ tab }: { tab: NotificationsTab }) {
  useTitle('Notifications')
  const navigate = useNavigate()
  const me = useMe()
  // Channels, rules, the log and SMTP are installation-wide: they need the permission held globally.
  const canManage = hasPermission(me, PERMISSIONS.notificationsManage) && Boolean(me?.scopes.global)
  const { data: channels } = useQuery({ ...notificationChannelsQuery, enabled: canManage })
  const { data: rules } = useQuery({ ...notificationRulesQuery, enabled: canManage })
  const { data: log } = useQuery({ ...notificationLogQuery({ limit: 300 }), enabled: canManage })
  const failing = channels?.filter((channel) => channel.enabled && channel.last_error).length
  // Deliveries that gave up after their last attempt, among the newest log rows.
  const failedDeliveries = log?.filter((entry) => entry.status === 'failed' && entry.finished_at).length

  return (
    <PageContainer className="grid grid-cols-1 gap-5">
      <PageHeader
        icon={<BellRing />}
        title="Notifications"
        description="Route alerts to email, chat and webhooks, with quiet hours and escalation."
      />
      {!canManage ? (
        <ErrorState
          title="No access"
          error={new Error('Notification settings are installation-wide and need the “Manage notifications” permission held globally.')}
        />
      ) : (
        <Tabs
          value={tab}
          onValueChange={(value) =>
            void navigate({
              to: '/settings/notifications',
              search: (prev) => ({ ...prev, tab: value === 'channels' ? undefined : (value as NotificationsTab) }),
              replace: true,
            })
          }
          className="gap-4"
        >
          <div className="-mx-4 [scrollbar-width:none] overflow-x-auto border-b border-border px-4 sm:-mx-6 sm:px-6">
            <TabsList variant="line" className="-mb-px h-10 w-max gap-4">
              <TabsTrigger value="channels" className="flex-none px-0">
                Channels
                <Count value={channels?.length} />
                <Count value={failing} tone="critical" />
              </TabsTrigger>
              <TabsTrigger value="rules" className="flex-none px-0">
                Rules
                <Count value={rules?.length} />
              </TabsTrigger>
              <TabsTrigger value="log" className="flex-none px-0">
                Delivery log
                <Count value={failedDeliveries} tone="critical" />
              </TabsTrigger>
              <TabsTrigger value="email" className="flex-none px-0">
                Email server
              </TabsTrigger>
            </TabsList>
          </div>
          <TabsContent value="channels">
            <ChannelsTab />
          </TabsContent>
          <TabsContent value="rules">
            <RulesTab />
          </TabsContent>
          <TabsContent value="log">
            <DeliveryLogTab />
          </TabsContent>
          <TabsContent value="email">
            <SmtpTab />
          </TabsContent>
        </Tabs>
      )}
    </PageContainer>
  )
}
