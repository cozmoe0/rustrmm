import { createFileRoute } from '@tanstack/react-router'
import { DeploymentsPage } from '@/features/software/deployments-page'

export const Route = createFileRoute('/_app/software/deployments/')({
  component: DeploymentsPage,
})
