import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { UsersPage } from '@/features/users/users-page'

export const Route = createFileRoute('/_app/settings/users')({
  validateSearch: z.object({ new: z.boolean().optional() }),
  staticData: { title: 'Users' },
  component: UsersRoute,
})

function UsersRoute() {
  const search = Route.useSearch()
  return <UsersPage createRequested={Boolean(search.new)} />
}
