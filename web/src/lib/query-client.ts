import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { errorMessage, isApiError } from './api/errors'

declare module '@tanstack/react-query' {
  interface Register {
    mutationMeta: { silent?: boolean; successMessage?: string }
    queryMeta: { silent?: boolean }
  }
}

export function createQueryClient() {
  return new QueryClient({
    queryCache: new QueryCache({
      onError: (error, query) => {
        if (query.meta?.silent) return
        if (isApiError(error) && (error.status === 401 || error.status === 404)) return
        // Background refetch failures of already-loaded data surface as a toast.
        if (query.state.data !== undefined) toast.error(errorMessage(error))
      },
    }),
    mutationCache: new MutationCache({
      onSuccess: (_data, _variables, _context, mutation) => {
        const message = mutation.meta?.successMessage
        if (message) toast.success(message)
      },
      onError: (error, _variables, _context, mutation) => {
        if (mutation.meta?.silent) return
        if (isApiError(error) && error.status === 401) return
        if (isApiError(error) && error.code === 'step_up_required') {
          toast.error('Re-authentication is required for this action.')
          return
        }
        toast.error(errorMessage(error))
      },
    }),
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        refetchOnWindowFocus: true,
        retry: (count, error) => {
          if (isApiError(error) && error.status >= 400 && error.status < 500) return false
          return count < 2
        },
      },
    },
  })
}
