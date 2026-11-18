import { Outlet, createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_app/automation/policies')({
  staticData: { title: 'Policies' },
  component: Outlet,
})
