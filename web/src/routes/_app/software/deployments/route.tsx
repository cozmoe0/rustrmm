import { Outlet, createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_app/software/deployments')({
  staticData: { title: 'Deployments' },
  component: Outlet,
})
