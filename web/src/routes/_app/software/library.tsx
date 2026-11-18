import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { LibraryPage } from '@/features/software/library-page'

export const Route = createFileRoute('/_app/software/library')({
  validateSearch: z.object({ edit: z.string().optional() }),
  staticData: { title: 'Library' },
  component: LibraryRoute,
})

function LibraryRoute() {
  return <LibraryPage edit={Route.useSearch().edit} />
}
