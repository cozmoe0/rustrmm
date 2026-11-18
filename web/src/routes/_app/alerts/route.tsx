import { createFileRoute } from '@tanstack/react-router'
import { AlertsLayout } from '@/features/monitoring/alerts-layout'

export const Route = createFileRoute('/_app/alerts')({
  staticData: { title: 'Alerts' },
  component: AlertsLayout,
})
