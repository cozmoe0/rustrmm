import { useState, type ReactNode } from 'react'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'

/**
 * Confirmation for destructive actions. With `confirmText`, the user must type the
 * exact text (usually the entity name) before the action unlocks.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Delete',
  confirmText,
  destructive = true,
  pending = false,
  onConfirm,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  description?: ReactNode
  confirmLabel?: string
  confirmText?: string
  destructive?: boolean
  pending?: boolean
  onConfirm: () => unknown
  children?: ReactNode
}) {
  const [typed, setTyped] = useState('')
  const locked = confirmText !== undefined && typed.trim() !== confirmText

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setTyped('')
        onOpenChange(next)
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description && <AlertDialogDescription>{description}</AlertDialogDescription>}
        </AlertDialogHeader>
        {children}
        {confirmText !== undefined && (
          <div className="grid gap-1.5">
            <Label htmlFor="confirm-text" className="text-dense text-muted-foreground">
              Type <span className="font-mono font-medium text-foreground">{confirmText}</span> to confirm
            </Label>
            <Input
              id="confirm-text"
              autoComplete="off"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
            />
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <Button
            variant={destructive ? 'destructive' : 'default'}
            disabled={locked || pending}
            onClick={() => void onConfirm()}
          >
            {pending && <Spinner data-icon="inline-start" />}
            {confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
