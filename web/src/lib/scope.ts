import { useNavigate, useSearch } from '@tanstack/react-router'
import { createStore } from './store'

/** Last explicit client choice; `all` means the user deliberately chose "All clients". */
export const storedClientStore = createStore<string>('all', {
  key: 'rustrmm.client',
  serialize: (value) => value,
  deserialize: (raw) => raw || undefined,
})

export interface ScopeSearch {
  client?: string
  site?: string
}

/** The global client/site scope, kept in the URL (`?client=&site=`) and remembered locally. */
export function useScope() {
  const search = useSearch({ strict: false }) as ScopeSearch
  const navigate = useNavigate()

  return {
    clientId: search.client,
    siteId: search.site,
    setClient(clientId: string | null) {
      storedClientStore.set(clientId ?? 'all')
      void navigate({
        to: '.',
        search: ((prev: ScopeSearch) => ({ ...prev, client: clientId ?? undefined, site: undefined })) as never,
      })
    },
    setSite(siteId: string | null) {
      void navigate({
        to: '.',
        search: ((prev: ScopeSearch) => ({ ...prev, site: siteId ?? undefined })) as never,
      })
    },
  }
}
