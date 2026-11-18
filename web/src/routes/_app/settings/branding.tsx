import { createFileRoute } from '@tanstack/react-router'
import { BrandingPage } from '@/features/platform/branding-page'

export const Route = createFileRoute('/_app/settings/branding')({
  staticData: { title: 'Branding' },
  component: BrandingPage,
})
