import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { NotificationsPage } from '@/features/notifications/notifications-page'

export const Route = createFileRoute('/_app/settings/notifications')({
  validateSearch: z.object({
    tab: z.enum(['channels', 'rules', 'log', 'email']).optional(),
  }),
  staticData: { title: 'Notifications' },
  component: NotificationsRoute,
})

function NotificationsRoute() {
  const { tab } = Route.useSearch()
  return <NotificationsPage tab={tab ?? 'channels'} />
}
