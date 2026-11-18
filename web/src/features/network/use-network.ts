/* Hooks and helpers shared by the network screens. */
import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { SelectOption } from '@/components/common/simple-select'
import { errorMessage, isApiError } from '@/lib/api/errors'
import { clientsQuery, sitesQuery } from '@/lib/api/queries'
import type { Site } from '@/lib/api/types'
import { useScope } from '@/lib/scope'

export interface SiteOption extends Site {
  client_name: string
}

/** Sites in the current client scope, labelled with their client. */
export function useScopedSites() {
  const { clientId } = useScope()
  const sites = useQuery(sitesQuery(clientId))
  const clients = useQuery(clientsQuery())
  return useMemo(() => {
    const names = new Map((clients.data ?? []).map((client) => [client.id, client.name]))
    const list: SiteOption[] = (sites.data ?? []).map((site) => ({ ...site, client_name: names.get(site.client_id) ?? '' }))
    list.sort((a, b) => a.client_name.localeCompare(b.client_name) || a.name.localeCompare(b.name))
    return { sites: list, byId: new Map(list.map((site) => [site.id, site])), isLoading: sites.isLoading || clients.isLoading }
  }, [sites.data, clients.data, sites.isLoading, clients.isLoading])
}

export function siteOptions(sites: SiteOption[], { any }: { any?: string } = {}): SelectOption[] {
  return [...(any ? [{ value: '', label: any }] : []), ...sites.map((site) => ({ value: site.id, label: site.name, group: site.client_name }))]
}

export function siteLabel(site: SiteOption | undefined, fallback?: string): string {
  if (!site) return fallback ?? 'Unknown site'
  return `${site.client_name} · ${site.name}`
}

/** Friendly messages for the network routes' conflict codes. */
export function networkErrorMessage(error: unknown): string {
  if (isApiError(error)) {
    switch (error.code) {
      case 'no_probe':
        return 'This site has no probe yet. Assign one under Network › Probes, then run the scan.'
      case 'probe_offline':
        return 'The site’s probe is offline, so nothing can scan right now. The scan runs once it reconnects (scheduled runs are skipped while it is offline).'
      case 'scan_running':
        return 'This scan is already running. Results stream in as the probe reports back.'
      case 'device_offline':
        return error.message || 'The device is offline.'
      case 'credential_in_use':
        return `${error.message}. Point those devices at another credential first.`
      case 'template_in_use':
        return `${error.message}. Remove it from those devices first.`
      case 'builtin_template':
        return 'Built-in templates are read-only. Duplicate it to make changes.'
      case 'already_monitored':
        return 'This asset is already monitored over SNMP.'
    }
  }
  return errorMessage(error)
}

