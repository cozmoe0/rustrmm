import { useState } from 'react'
import type { Client } from '@/lib/api/types'
import { EntityAvatar } from '@/components/common/misc'
import { cn } from '@/lib/utils'

const SIZES = { xs: 'size-5 rounded-[5px] p-0.5', sm: 'size-6 rounded-md p-0.5', md: 'size-8 rounded-lg p-1', lg: 'size-11 rounded-xl p-1.5' }

/** A client's uploaded logo (served sandboxed by the server), falling back to its initials avatar. */
export function ClientLogo({ client, size = 'md', className }: { client: Pick<Client, 'id' | 'name' | 'accent_color' | 'logo_url'>; size?: keyof typeof SIZES; className?: string }) {
  const [failed, setFailed] = useState<string | null>(null)
  if (!client.logo_url || failed === client.logo_url) return <EntityAvatar name={client.name} seed={client.id} accent={client.accent_color} size={size} className={className} />
  return (
    <span className={cn('inline-flex shrink-0 items-center justify-center overflow-hidden bg-white ring-1 ring-black/10 dark:ring-white/10', SIZES[size], className)}>
      <img src={client.logo_url} alt="" className="size-full object-contain" onError={() => setFailed(client.logo_url)} />
    </span>
  )
}
