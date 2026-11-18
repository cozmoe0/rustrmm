import { createFileRoute } from '@tanstack/react-router'
import { DeploymentPage } from '@/features/software/deployment-page'
import { deploymentQuery } from '@/lib/api/queries'

export const Route = createFileRoute('/_app/software/deployments/$deploymentId')({
  staticData: { title: 'Deployment' },
  loader: ({ context, params }) => {
    void context.queryClient.prefetchQuery(deploymentQuery(params.deploymentId))
  },
  component: DeploymentRoute,
})

function DeploymentRoute() {
  return <DeploymentPage deploymentId={Route.useParams().deploymentId} />
}
