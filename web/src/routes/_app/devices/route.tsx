import { Outlet, createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_app/devices')({
  staticData: { title: 'Devices' },
  component: Outlet,
})
