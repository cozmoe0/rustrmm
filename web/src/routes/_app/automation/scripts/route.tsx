import { Outlet, createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_app/automation/scripts')({
  staticData: { title: 'Scripts' },
  component: Outlet,
})
