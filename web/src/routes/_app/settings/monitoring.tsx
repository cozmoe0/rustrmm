import { createFileRoute } from '@tanstack/react-router'
import { MonitoringSettingsPage } from '@/features/notifications/monitoring-settings-page'

export const Route = createFileRoute('/_app/settings/monitoring')({
  staticData: { title: 'Monitoring settings' },
  component: MonitoringSettingsPage,
})
