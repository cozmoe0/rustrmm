import { useBlocker } from '@tanstack/react-router'
import { ConfirmDialog } from '@/components/common/confirm-dialog'

/** Asks before leaving a page with unsaved edits (switching tabs on the same page is allowed). */
export function UnsavedChangesGuard({ when, what = 'changes' }: { when: boolean; what?: string }) {
  const blocker = useBlocker({
    shouldBlockFn: ({ current, next }) => when && current.pathname !== next.pathname,
    enableBeforeUnload: () => when,
    withResolver: true,
  })
  return (
    <ConfirmDialog
      open={blocker.status === 'blocked'}
      onOpenChange={(open) => !open && blocker.status === 'blocked' && blocker.reset()}
      title={`Discard unsaved ${what}?`}
      description="You have edits that haven't been saved. If you leave now they will be lost."
      confirmLabel="Discard and leave"
      onConfirm={() => blocker.status === 'blocked' && blocker.proceed()}
    />
  )
}
