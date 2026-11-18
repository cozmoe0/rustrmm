/* Power actions (restart, shut down, sign out, lock, cancel) and "Message user" for a device. */
import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { MessageSquareText, Power, RotateCw, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { SimpleSelect } from '@/components/common/simple-select'
import { remoteApi } from '@/lib/api/endpoints'
import type { DeviceDetail } from '@/lib/api/types'
import { deviceName } from '@/lib/devices'
import { POWER_DELAYS } from '@/lib/remote'
import { cn } from '@/lib/utils'
import { toastRemoteError, useDeviceGoneHandler } from './remote-hooks'
import { delayLabel, usePowerAction } from './use-power-action'

const MESSAGE_TIMEOUTS = [
  { value: '0', label: 'Until dismissed' },
  { value: '30', label: '30 seconds' },
  { value: '60', label: '1 minute' },
  { value: '300', label: '5 minutes' },
]

function signedInUser(device: DeviceDetail) {
  return device.last_user?.split('\\').pop() ?? null
}

export function RestartDialog({
  device,
  open,
  initialAction,
  onOpenChange,
}: {
  device: DeviceDetail
  open: boolean
  initialAction: 'reboot' | 'shutdown'
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {open && <RestartForm device={device} initialAction={initialAction} onDone={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  )
}

function RestartForm({ device, initialAction, onDone }: { device: DeviceDetail; initialAction: 'reboot' | 'shutdown'; onDone: () => void }) {
  const [action, setAction] = useState<'reboot' | 'shutdown'>(initialAction)
  const [delay, setDelay] = useState(device.os_family === 'linux' ? 60 : 0)
  const [message, setMessage] = useState('')
  const [typed, setTyped] = useState('')
  const power = usePowerAction(device, onDone)
  const user = signedInUser(device)
  const confirmed = typed.trim() === device.hostname

  return (
    <>
      <DialogHeader>
        <DialogTitle>{action === 'reboot' ? 'Restart' : 'Shut down'} {deviceName(device)}?</DialogTitle>
        <DialogDescription>
          {action === 'reboot' ? 'The device restarts and reconnects when the agent starts again.' : 'The device powers off and stays offline until someone turns it on.'}
          {user && (
            <>
              {' '}
              <span className="font-medium text-foreground">{user}</span> may be signed in.
            </>
          )}
        </DialogDescription>
      </DialogHeader>
      <form
        id="power-form"
        noValidate
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault()
          if (confirmed) power.mutate({ action, delay_secs: delay, message: message.trim() })
        }}
      >
        <ToggleGroup value={[action]} onValueChange={(value: string[]) => value[0] && setAction(value[0] as 'reboot' | 'shutdown')} variant="outline" spacing={0} className="w-full">
          <ToggleGroupItem value="reboot" className="flex-1 gap-1.5 aria-pressed:bg-surface-3">
            <RotateCw />
            Restart
          </ToggleGroupItem>
          <ToggleGroupItem value="shutdown" className="flex-1 gap-1.5 aria-pressed:bg-surface-3">
            <Power />
            Shut down
          </ToggleGroupItem>
        </ToggleGroup>
        <Field>
          <FieldLabel htmlFor="power-delay">When</FieldLabel>
          <SimpleSelect
            id="power-delay"
            value={String(delay)}
            onValueChange={(value) => setDelay(Number(value))}
            options={POWER_DELAYS.filter((option) => device.os_family !== 'linux' || option.value !== 0).map((option) => ({ value: String(option.value), label: option.label }))}
          />
          {device.os_family === 'linux' && <FieldDescription>Linux schedules shutdowns in whole minutes.</FieldDescription>}
        </Field>
        <Field>
          <FieldLabel htmlFor="power-message">Message to signed-in users</FieldLabel>
          <Textarea
            id="power-message"
            value={message}
            maxLength={500}
            rows={2}
            placeholder={`IT is ${action === 'reboot' ? 'restarting' : 'shutting down'} this computer to finish maintenance. Please save your work.`}
            onChange={(event) => setMessage(event.target.value)}
          />
          <FieldDescription>Optional. Shown with the shutdown warning{delay === 0 ? ' (most useful with a delay)' : ''}.</FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="power-confirm" className="font-normal text-muted-foreground">
            Type <span className="font-mono font-medium text-foreground">{device.hostname}</span> to confirm
          </FieldLabel>
          <Input id="power-confirm" autoComplete="off" spellCheck={false} value={typed} onChange={(event) => setTyped(event.target.value)} />
        </Field>
        <p className="flex items-center gap-1.5 text-micro text-subtle-foreground">
          <ShieldCheck className="size-3.5" />
          Restart and shut down ask for a fresh MFA check.
        </p>
      </form>
      <DialogFooter>
        <Button variant="ghost" onClick={onDone} disabled={power.isPending}>
          Cancel
        </Button>
        <Button type="submit" form="power-form" variant="destructive" disabled={!confirmed || power.isPending}>
          {power.isPending && <Spinner data-icon="inline-start" />}
          {action === 'reboot' ? 'Restart' : 'Shut down'} {delayLabel(delay)}
        </Button>
      </DialogFooter>
    </>
  )
}

export function SessionPowerDialogs({ device, kind, onOpenChange }: { device: DeviceDetail; kind: 'logoff' | 'lock' | null; onOpenChange: (open: boolean) => void }) {
  const power = usePowerAction(device, () => onOpenChange(false))
  const user = signedInUser(device)
  return (
    <>
      <ConfirmDialog
        open={kind === 'logoff'}
        onOpenChange={onOpenChange}
        title={`Sign out the user on ${deviceName(device)}?`}
        description={`Signs out ${user ? user : 'the interactive user'} immediately. Unsaved work in open apps is lost. Needs a fresh MFA check.`}
        confirmLabel="Sign out user"
        confirmText={device.hostname}
        pending={power.isPending}
        onConfirm={() => power.mutate({ action: 'logoff' })}
      />
      <ConfirmDialog
        open={kind === 'lock'}
        onOpenChange={onOpenChange}
        title={`Lock ${deviceName(device)}?`}
        description="Locks the console session. The user’s apps keep running and they can sign back in with their password."
        confirmLabel="Lock now"
        destructive={false}
        pending={power.isPending}
        onConfirm={() => power.mutate({ action: 'lock' })}
      />
    </>
  )
}

export function MessageDialog({ device, open, onOpenChange }: { device: DeviceDetail; open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">{open && <MessageForm device={device} onDone={() => onOpenChange(false)} />}</DialogContent>
    </Dialog>
  )
}

function MessageForm({ device, onDone }: { device: DeviceDetail; onDone: () => void }) {
  const onDeviceGone = useDeviceGoneHandler(device.id)
  const [title, setTitle] = useState('Message from IT')
  const [body, setBody] = useState('')
  const [timeout, setTimeoutValue] = useState('0')
  const [touched, setTouched] = useState(false)
  const bodyError = body.trim() ? null : 'Write a message.'
  const user = signedInUser(device)

  const send = useMutation({
    mutationFn: () => remoteApi.message(device.id, { title: title.trim() || 'Message from IT', body: body.trim(), timeout_secs: Number(timeout) }),
    meta: { silent: true },
    onSuccess: () => {
      toast.success(`Message sent to ${deviceName(device)}`, { description: user ? `Shown to ${user}.` : undefined })
      onDone()
    },
    onError: (error) => {
      onDeviceGone(error)
      toastRemoteError(error, 'Couldn’t send the message')
    },
  })

  const delivery =
    device.os_family === 'windows'
      ? 'Shown as a message box in the console session.'
      : device.os_family === 'linux'
        ? 'Broadcast to signed-in terminals with wall.'
        : 'Shown as a dialog on the desktop.'

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <MessageSquareText className="size-4 text-subtle-foreground" />
          Message the user on {deviceName(device)}
        </DialogTitle>
        <DialogDescription>{delivery}</DialogDescription>
      </DialogHeader>
      <form
        id="message-form"
        noValidate
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault()
          setTouched(true)
          if (!bodyError) send.mutate()
        }}
      >
        {device.os_family !== 'linux' && (
          <Field>
            <FieldLabel htmlFor="message-title">Title</FieldLabel>
            <Input id="message-title" value={title} maxLength={80} onChange={(event) => setTitle(event.target.value)} />
          </Field>
        )}
        <Field data-invalid={(touched && Boolean(bodyError)) || undefined}>
          <FieldLabel htmlFor="message-body">Message</FieldLabel>
          <Textarea
            id="message-body"
            autoFocus
            value={body}
            rows={4}
            maxLength={1000}
            aria-invalid={(touched && Boolean(bodyError)) || undefined}
            placeholder="Hi! We’re installing an update on your computer in the next few minutes. Please save your work."
            onChange={(event) => setBody(event.target.value)}
          />
          <div className="flex items-center justify-between">
            {touched && bodyError ? <FieldError>{bodyError}</FieldError> : <span />}
            <span className={cn('tabular text-micro', body.length > 900 ? 'text-warning' : 'text-subtle-foreground')}>{body.length}/1000</span>
          </div>
        </Field>
        {device.os_family !== 'linux' && (
          <Field>
            <FieldLabel htmlFor="message-timeout">Close automatically</FieldLabel>
            <SimpleSelect id="message-timeout" value={timeout} onValueChange={setTimeoutValue} options={MESSAGE_TIMEOUTS} />
          </Field>
        )}

        {/* Preview */}
        <div className="rounded-lg bg-surface-2 p-3 ring-1 ring-border">
          <div className="eyebrow mb-2">Preview</div>
          {device.os_family === 'linux' ? (
            <pre className="overflow-x-auto font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
              {`Broadcast message from root@${device.hostname}:\n\n${body.trim() || 'Your message'}`}
            </pre>
          ) : (
            <div className="mx-auto max-w-sm overflow-hidden rounded-md bg-card shadow-popover">
              <div className="border-b border-border px-3 py-1.5 text-micro font-medium">{title.trim() || 'Message from IT'}</div>
              <p className="px-3 py-3 text-dense break-words whitespace-pre-wrap">{body.trim() || <span className="text-subtle-foreground">Your message</span>}</p>
              <div className="flex justify-end px-3 pb-2.5">
                <span className="rounded-sm bg-surface-3 px-3 py-0.5 text-micro ring-1 ring-border">OK</span>
              </div>
            </div>
          )}
        </div>
      </form>
      <DialogFooter>
        <Button variant="ghost" onClick={onDone} disabled={send.isPending}>
          Cancel
        </Button>
        <Button type="submit" form="message-form" disabled={send.isPending}>
          {send.isPending ? <Spinner data-icon="inline-start" /> : <MessageSquareText data-icon="inline-start" />}
          Send message
        </Button>
      </DialogFooter>
    </>
  )
}
