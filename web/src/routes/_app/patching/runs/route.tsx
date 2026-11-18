import { Outlet, createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_app/patching/runs')({
  staticData: { title: 'Patch runs' },
  component: Outlet,
})
