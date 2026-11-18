import { createFileRoute } from '@tanstack/react-router'
import { ContactDetailPage } from '@/features/tickets/contact-detail-page'

export const Route = createFileRoute('/_app/tickets/contacts/$contactId')({
  staticData: { title: 'Contact' },
  component: ContactRoute,
})

function ContactRoute() {
  const { contactId } = Route.useParams()
  return <ContactDetailPage contactId={contactId} />
}
