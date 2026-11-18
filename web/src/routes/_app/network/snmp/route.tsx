import { Outlet, createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_app/network/snmp')({
  staticData: { title: 'SNMP devices' },
  component: Outlet,
})
