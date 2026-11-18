import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { ProductPage } from '@/features/software/product-page'

export const Route = createFileRoute('/_app/software/product')({
  validateSearch: z.object({ name: z.string().catch(''), publisher: z.string().optional() }),
  staticData: { title: 'Product' },
  component: ProductRoute,
})

function ProductRoute() {
  const { name, publisher } = Route.useSearch()
  return <ProductPage key={`${name}|${publisher ?? ''}`} name={name} publisher={publisher ?? null} />
}
