import { Outlet, createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_app/clients')({
  staticData: { title: 'Clients' },
  component: Outlet,
})
