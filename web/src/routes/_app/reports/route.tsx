import { createFileRoute } from '@tanstack/react-router'
import { ReportsLayout } from '@/features/reports/reports-layout'

export const Route = createFileRoute('/_app/reports')({
  staticData: { title: 'Reports' },
  component: ReportsLayout,
})
