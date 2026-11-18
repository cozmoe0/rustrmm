import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { JobPage } from '@/features/automation/job-page'
import { jobQuery } from '@/lib/api/queries'

export const Route = createFileRoute('/_app/automation/jobs/$jobId')({
  validateSearch: z.object({
    run: z.string().optional(),
    device: z.string().optional(),
  }),
  staticData: { title: 'Job', dynamicTitle: 'job' },
  loader: ({ context, params }) => {
    void context.queryClient.prefetchQuery(jobQuery(params.jobId))
  },
  component: JobRoute,
})

function JobRoute() {
  const { jobId } = Route.useParams()
  const search = Route.useSearch()
  return <JobPage jobId={jobId} runId={search.run} deviceId={search.device} />
}
