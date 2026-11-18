import { createFileRoute } from '@tanstack/react-router'
import { AutomationLayout } from '@/features/automation/automation-layout'

export const Route = createFileRoute('/_app/automation')({
  staticData: { title: 'Automation' },
  component: AutomationLayout,
})
