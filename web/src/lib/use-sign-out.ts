import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { setCsrfToken } from './api/client'
import { authApi } from './api/endpoints'

/** Ends the session server-side, wipes cached data and returns to the sign-in page. */
export function useSignOut() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  return async () => {
    try {
      await authApi.logout()
    } finally {
      setCsrfToken(null)
      queryClient.clear()
      void navigate({ to: '/login' })
    }
  }
}
