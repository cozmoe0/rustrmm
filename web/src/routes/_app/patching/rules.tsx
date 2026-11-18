import { createFileRoute } from '@tanstack/react-router'
import { RulesPage } from '@/features/patching/rules-page'

export const Route = createFileRoute('/_app/patching/rules')({
  staticData: { title: 'Approval rules' },
  component: RulesPage,
})
