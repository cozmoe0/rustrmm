import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { LibraryPage } from '@/features/reports/library-page'

export const Route = createFileRoute('/_app/reports/')({
  validateSearch: z.object({ run: z.string().optional() }),
  component: LibraryRoute,
})

function LibraryRoute() {
  return <LibraryPage runType={Route.useSearch().run} />
}
