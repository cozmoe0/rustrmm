import { createFileRoute } from '@tanstack/react-router'
import { TemplatesPage } from '@/features/network/templates-page'

export const Route = createFileRoute('/_app/network/templates')({
  staticData: { title: 'SNMP templates' },
  component: TemplatesPage,
})
