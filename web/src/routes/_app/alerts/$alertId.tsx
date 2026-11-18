import { createFileRoute, redirect } from '@tanstack/react-router'

/** Deep links from notifications (`{console_url}/alerts/{id}`) open the inbox with that alert selected. */
export const Route = createFileRoute('/_app/alerts/$alertId')({
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/alerts', search: { alert: params.alertId, status: 'all' }, replace: true })
  },
})
