import { Outlet, createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_app/automation/groups')({
  staticData: { title: 'Device groups' },
  component: Outlet,
})
