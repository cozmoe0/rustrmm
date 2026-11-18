import { createFileRoute } from '@tanstack/react-router'
import { CredentialsPage } from '@/features/network/credentials-page'

export const Route = createFileRoute('/_app/network/credentials')({
  staticData: { title: 'SNMP credentials' },
  component: CredentialsPage,
})
