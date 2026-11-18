import { useLocation, useNavigate, useSearch } from '@tanstack/react-router'
import { facetsFromSearch, searchFromFacets, type DeviceFacets, type DeviceListSearch } from '@/lib/devices'

/** Navigates the device list to the given facets (from any page). */
export function useApplyFacets() {
  const navigate = useNavigate()
  return (facets: DeviceFacets) =>
    void navigate({
      to: '/devices',
      search: (prev: Record<string, unknown>) => ({ client: prev.client, site: prev.site, ...searchFromFacets(facets) }) as never,
    })
}

/** The device list's current facets, or none when another page is showing. */
export function useCurrentFacets(): { facets: DeviceFacets; onList: boolean } {
  const { pathname } = useLocation()
  const search = useSearch({ strict: false }) as DeviceListSearch
  const onList = pathname === '/devices'
  return { facets: onList ? facetsFromSearch(search) : {}, onList }
}
