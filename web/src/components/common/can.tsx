import type { ReactNode } from 'react'
import { useMe, hasAnyPermission, hasPermission } from '@/lib/permissions'

/** Renders children only when the signed-in user holds the permission (UI gating only). */
export function Can({
  permission,
  anyOf,
  fallback = null,
  children,
}: {
  permission?: string
  anyOf?: readonly string[]
  fallback?: ReactNode
  children: ReactNode
}) {
  const me = useMe()
  const allowed = permission ? hasPermission(me, permission) : anyOf ? hasAnyPermission(me, anyOf) : true
  return <>{allowed ? children : fallback}</>
}
