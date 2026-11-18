import { useCallback, useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { KeyRound, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Spinner } from '@/components/ui/spinner'
import { setStepUpHandler } from '@/lib/api/client'
import { authApi } from '@/lib/api/endpoints'
import { errorMessage } from '@/lib/api/errors'
import { keys } from '@/lib/api/queries'
import type { Me } from '@/lib/api/types'
import { getAssertion, isWebauthnSupported, webauthnErrorMessage } from '@/lib/webauthn'
import { TotpInput } from './totp-input'

/**
 * Global re-authentication dialog. The API client calls the registered handler when a request
 * fails with `step_up_required`; the original request is retried once the promise resolves true.
 */
export function StepUpProvider() {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const resolver = useRef<((value: boolean) => void) | null>(null)

  const finish = useCallback((result: boolean) => {
    resolver.current?.(result)
    resolver.current = null
    setOpen(false)
    setCode('')
    setError(null)
    setPending(false)
  }, [])

  useEffect(() => {
    setStepUpHandler(
      () =>
        new Promise<boolean>((resolve) => {
          resolver.current = resolve
          setOpen(true)
        }),
    )
    return () => setStepUpHandler(null)
  }, [])

  function remember(steppedUpUntil: string) {
    queryClient.setQueryData<Me>(keys.me, (me) =>
      me ? { ...me, session: { ...me.session, stepped_up_until: steppedUpUntil } } : me,
    )
  }

  async function verifyTotp(value: string) {
    if (value.length !== 6 || pending) return
    setPending(true)
    setError(null)
    try {
      const result = await authApi.stepUpTotp(value)
      remember(result.stepped_up_until)
      finish(true)
    } catch (err) {
      setError(errorMessage(err, 'That code did not work'))
      setCode('')
      setPending(false)
    }
  }

  async function verifyPasskey() {
    setPending(true)
    setError(null)
    try {
      const { options } = await authApi.stepUpWebauthnStart()
      const credential = await getAssertion(options)
      const result = await authApi.stepUpWebauthnFinish(credential)
      remember(result.stepped_up_until)
      finish(true)
    } catch (err) {
      setError(err instanceof DOMException ? webauthnErrorMessage(err) : errorMessage(err))
      setPending(false)
    }
  }

  const me = queryClient.getQueryData<Me>(keys.me)
  const hasPasskeys = (me?.user.mfa.passkeys ?? 0) > 0 && isWebauthnSupported()

  return (
    <Dialog open={open} onOpenChange={(next) => !next && finish(false)}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <div className="mb-1 flex size-10 items-center justify-center rounded-xl bg-primary/12 text-primary ring-1 ring-primary/25">
            <ShieldCheck className="size-5" />
          </div>
          <DialogTitle>Confirm it&apos;s you</DialogTitle>
          <DialogDescription>
            This action is sensitive. Enter a code from your authenticator app to continue — you won&apos;t be
            asked again for a few minutes.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 py-2">
          <TotpInput
            value={code}
            onChange={setCode}
            onComplete={(value) => void verifyTotp(value)}
            disabled={pending}
            invalid={Boolean(error)}
          />
          <p role="alert" className="min-h-5 text-center text-dense text-critical">
            {error}
          </p>
        </div>

        <DialogFooter>
          {hasPasskeys && (
            <Button variant="outline" onClick={() => void verifyPasskey()} disabled={pending} className="sm:mr-auto">
              <KeyRound data-icon="inline-start" />
              Use a passkey
            </Button>
          )}
          <Button variant="ghost" onClick={() => finish(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={() => void verifyTotp(code)} disabled={pending || code.length !== 6}>
            {pending && <Spinner data-icon="inline-start" />}
            Verify
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
