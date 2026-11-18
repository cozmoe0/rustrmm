import { createFileRoute } from '@tanstack/react-router'
import { AutomationSettingsPage } from '@/features/automation/automation-settings-page'

export const Route = createFileRoute('/_app/automation/settings')({
  staticData: { title: 'Automation settings' },
  component: AutomationSettingsPage,
})
