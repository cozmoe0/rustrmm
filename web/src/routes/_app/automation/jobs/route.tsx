import { Outlet, createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_app/automation/jobs')({
  staticData: { title: 'Jobs' },
  component: Outlet,
})
