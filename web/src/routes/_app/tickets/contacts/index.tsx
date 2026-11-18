import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { ContactsPage } from '@/features/tickets/contacts-page'

export const Route = createFileRoute('/_app/tickets/contacts/')({
  validateSearch: z.object({
    q: z.string().optional(),
    /** Opens the import dialog. */
    import: z.boolean().optional(),
  }),
  staticData: { title: 'Contacts' },
  component: ContactsRoute,
})

function ContactsRoute() {
  const search = Route.useSearch()
  return <ContactsPage search={search} />
}
