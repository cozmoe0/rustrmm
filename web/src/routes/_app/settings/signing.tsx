import { createFileRoute } from '@tanstack/react-router'
import { SigningPage } from '@/features/platform/signing-page'

export const Route = createFileRoute('/_app/settings/signing')({
  staticData: { title: 'Code signing' },
  component: SigningPage,
})
