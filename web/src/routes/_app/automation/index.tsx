import { createFileRoute, redirect } from '@tanstack/react-router'
import { meQuery } from '@/lib/api/queries'

export const Route = createFileRoute('/_app/automation/')({
  beforeLoad: async ({ context }) => {
    const me = await context.queryClient.ensureQueryData(meQuery)
    throw redirect({
      to: me.permissions.includes('scripts.view') ? '/automation/scripts' : '/automation/policies',
      replace: true,
    })
  },
})
