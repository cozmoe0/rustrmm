/* The escrow items table (Secrets page and the device page), the item drawer with reveal history, and delete confirmation. */
import { useMemo } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { ColumnDef } from '@tanstack/react-table'
import { Ellipsis, ExternalLink, Eye, History, KeyRound, MonitorSmartphone, ScrollText, Trash } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { DataTable } from '@/components/common/data-table'
import { KeyValue, Mono, RelativeTime, UserAvatar } from '@/components/common/misc'
import { auditApi, escrowApi } from '@/lib/api/endpoints'
import { errorMessage } from '@/lib/api/errors'
import { escrowKeys } from '@/lib/api/queries'
import type { EscrowItem } from '@/lib/api/types'
import { formatDateTime, formatNumber } from '@/lib/format'
import { itemSubject, KIND_LABEL, shortIdentifier } from '@/lib/escrow/secret'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'
import { cn } from '@/lib/utils'
import { ItemStateBadge, KindLabel, KindTile } from './escrow-ui'

export interface EscrowTableProps {
  items: EscrowItem[]
  loading?: boolean
  showDevice?: boolean
  onOpen: (item: EscrowItem) => void
  onReveal: (item: EscrowItem) => void
  onDelete: (item: EscrowItem) => void
  empty?: React.ReactNode
}

export function RevealButton({ item, onReveal, size = 'xs' }: { item: EscrowItem; onReveal: (item: EscrowItem) => void; size?: 'xs' | 'sm' }) {
  const me = useMe()
  const allowed = hasPermission(me, PERMISSIONS.secretsReveal)
  if (!allowed) {
    return (
      <Tooltip>
        <TooltipTrigger render={<span className="inline-flex" tabIndex={0} aria-label="Reveal — needs the Reveal secrets permission" />}>
          <Button variant="outline" size={size} disabled aria-hidden="true" tabIndex={-1}>
            <Eye data-icon="inline-start" />
            Reveal
          </Button>
        </TooltipTrigger>
        <TooltipContent>You need the “Reveal secrets” permission</TooltipContent>
      </Tooltip>
    )
  }
  return (
    <Button
      variant="outline"
      size={size}
      onClick={(event) => {
        event.stopPropagation()
        onReveal(item)
      }}
    >
      <Eye data-icon="inline-start" />
      Reveal
    </Button>
  )
}

export function EscrowTable({ items, loading, showDevice = true, onOpen, onReveal, onDelete, empty }: EscrowTableProps) {
  const me = useMe()
  const canManage = hasPermission(me, PERMISSIONS.secretsManage)
  const columns = useMemo<ColumnDef<EscrowItem>[]>(
    () => [
      { id: 'kind', accessorFn: (item) => item.kind, header: 'Kind', cell: ({ row }) => <KindLabel kind={row.original.kind} /> },
      ...(showDevice
        ? [
            {
              id: 'device',
              accessorFn: (item: EscrowItem) => item.hostname.toLowerCase(),
              header: 'Device',
              cell: ({ row }: { row: { original: EscrowItem } }) => (
                <div className="min-w-0 leading-tight">
                  {row.original.device_id ? (
                    <Link
                      to="/devices/$deviceId"
                      params={{ deviceId: row.original.device_id }}
                      search={{ tab: 'secrets' }}
                      onClick={(event) => event.stopPropagation()}
                      className="block max-w-52 truncate font-medium hover:underline"
                    >
                      {row.original.hostname}
                    </Link>
                  ) : (
                    <span className="block max-w-52 truncate font-medium text-muted-foreground">{row.original.hostname}</span>
                  )}
                  <span className="block max-w-52 truncate text-[10.5px] text-subtle-foreground">{row.original.client_name}</span>
                </div>
              ),
            } satisfies ColumnDef<EscrowItem>,
          ]
        : []),
      {
        id: 'subject',
        accessorFn: (item) => itemSubject(item).toLowerCase(),
        header: 'Protects',
        cell: ({ row }) => (
          <div className="min-w-0 leading-tight">
            <span className="block max-w-56 truncate">{itemSubject(row.original)}</span>
            <span className="block max-w-56 truncate font-mono text-[10.5px] text-subtle-foreground">{shortIdentifier(row.original.identifier)}</span>
          </div>
        ),
      },
      {
        id: 'captured',
        accessorFn: (item) => item.captured_at,
        header: 'Captured',
        cell: ({ row }) => <RelativeTime value={row.original.captured_at} className="text-muted-foreground" />,
      },
      {
        id: 'reveals',
        accessorFn: (item) => item.reveal_count,
        header: 'Reveals',
        cell: ({ row }) =>
          row.original.reveal_count === 0 ? (
            <span className="text-subtle-foreground">Never</span>
          ) : (
            <span className="inline-flex items-center gap-1.5">
              <span className="tabular font-medium">{formatNumber(row.original.reveal_count)}</span>
              <span className="text-micro text-subtle-foreground">
                · last <RelativeTime value={row.original.last_revealed_at} />
              </span>
            </span>
          ),
      },
      { id: 'state', accessorFn: (item) => (item.superseded_at ? 1 : 0), header: 'State', cell: ({ row }) => <ItemStateBadge item={row.original} /> },
      {
        id: 'actions',
        header: '',
        enableSorting: false,
        meta: { align: 'right', className: 'w-36' },
        cell: ({ row }) => (
          <div className="flex items-center justify-end gap-1">
            <RevealButton item={row.original} onReveal={onReveal} />
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`More for ${itemSubject(row.original)}`} onClick={(event) => event.stopPropagation()} />}>
                <Ellipsis />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuItem onClick={() => onOpen(row.original)}>
                  <History />
                  Details and reveals
                </DropdownMenuItem>
                {row.original.device_id && (
                  <DropdownMenuItem render={<Link to="/devices/$deviceId" params={{ deviceId: row.original.device_id }} search={{ tab: 'secrets' }} />}>
                    <MonitorSmartphone />
                    Open device
                  </DropdownMenuItem>
                )}
                {canManage && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onClick={() => onDelete(row.original)}>
                      <Trash />
                      Delete…
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ),
      },
    ],
    [showDevice, onReveal, onOpen, onDelete, canManage],
  )
  return (
    <DataTable
      data={items}
      columns={columns}
      loading={loading}
      getRowId={(item) => item.id}
      onRowClick={onOpen}
      initialSorting={[{ id: 'captured', desc: true }]}
      virtualHeight={items.length > 16 ? 'min(68vh, 720px)' : undefined}
      caption="Escrowed secrets"
      rowClassName={(item) => (item.superseded_at ? 'opacity-70' : undefined)}
      empty={empty}
    />
  )
}

/** The item drawer: metadata, reveal count, and (with `audit.view`) each reveal with its reason from the audit log. */
export function EscrowItemSheet({ item, onClose, onReveal, onDelete }: { item: EscrowItem | null; onClose: () => void; onReveal: (item: EscrowItem) => void; onDelete: (item: EscrowItem) => void }) {
  const me = useMe()
  const canAudit = hasPermission(me, PERMISSIONS.auditView)
  const canManage = hasPermission(me, PERMISSIONS.secretsManage)
  const reveals = useQuery({
    queryKey: ['audit', 'escrow-item', item?.id ?? 'none'],
    queryFn: async () => (await auditApi.list({ action: 'secret.revealed', q: item!.hostname }, null, 200)).items.filter((event) => event.target?.id === item!.id),
    enabled: Boolean(item) && canAudit && (item?.reveal_count ?? 0) > 0,
    meta: { silent: true },
  })
  return (
    <Sheet open={Boolean(item)} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="gap-0 p-0 shadow-popover data-[side=right]:w-full data-[side=right]:sm:max-w-[520px]">
        {item && (
          <>
            <SheetHeader className="gap-3 border-b border-border px-5 pt-5 pb-4">
              <div className="flex items-start gap-3 pr-8">
                <KindTile kind={item.kind} size="lg" />
                <div className="min-w-0">
                  <SheetTitle className="text-base leading-snug">{itemSubject(item)}</SheetTitle>
                  <SheetDescription>
                    {KIND_LABEL[item.kind]} · {item.hostname}
                  </SheetDescription>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <ItemStateBadge item={item} />
                <RevealButton item={item} onReveal={onReveal} size="sm" />
                {item.device_id && (
                  <Button variant="ghost" size="sm" render={<Link to="/devices/$deviceId" params={{ deviceId: item.device_id }} search={{ tab: 'secrets' }} />} nativeButton={false}>
                    <MonitorSmartphone data-icon="inline-start" />
                    Device
                  </Button>
                )}
                {canManage && (
                  <Button variant="ghost" size="sm" className="ml-auto hover:text-critical" onClick={() => onDelete(item)}>
                    <Trash data-icon="inline-start" />
                    Delete
                  </Button>
                )}
              </div>
            </SheetHeader>
            <div className="grid flex-1 content-start gap-5 overflow-y-auto px-5 py-4">
              <dl>
                <KeyValue label="Device">{item.device_id ? item.hostname : `${item.hostname} (deleted)`}</KeyValue>
                <KeyValue label="Client">{item.client_name}</KeyValue>
                <KeyValue label="Identifier">
                  <Mono className="break-all">{item.identifier}</Mono>
                </KeyValue>
                {Object.entries(item.metadata)
                  .filter(([, value]) => typeof value === 'string' && value)
                  .map(([key, value]) => (
                    <KeyValue key={key} label={key.replace(/_/g, ' ').replace(/^\w/, (letter) => letter.toUpperCase())}>
                      {key.includes('id') ? <Mono className="break-all">{String(value)}</Mono> : String(value)}
                    </KeyValue>
                  ))}
                <KeyValue label="Captured">{formatDateTime(item.captured_at)}</KeyValue>
                {item.superseded_at && <KeyValue label="Superseded">{formatDateTime(item.superseded_at)}</KeyValue>}
              </dl>
              <section className="grid gap-2">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold">Reveals</h3>
                  <span className="text-micro text-muted-foreground">
                    {item.reveal_count === 0 ? 'Never revealed' : `${formatNumber(item.reveal_count)} · last ${item.last_revealed_at ? formatDateTime(item.last_revealed_at) : ''}`}
                  </span>
                </div>
                {item.reveal_count > 0 &&
                  (!canAudit ? (
                    <p className="text-micro text-muted-foreground">Who revealed it and why is in the audit log, which needs the “View audit log” permission.</p>
                  ) : reveals.isLoading ? (
                    <Skeleton className="h-16 rounded-lg" />
                  ) : (
                    <ol className="grid gap-2">
                      {(reveals.data ?? []).map((event) => (
                        <li key={event.id} className="flex gap-2.5 rounded-lg bg-surface-2 px-3 py-2 ring-1 ring-border">
                          <UserAvatar name={event.actor.name ?? '?'} size="sm" />
                          <div className="min-w-0 flex-1 text-dense">
                            <div className="flex flex-wrap items-baseline justify-between gap-x-2">
                              <span className="font-medium">{event.actor.name}</span>
                              <RelativeTime value={event.at} className="text-micro text-subtle-foreground" />
                            </div>
                            <p className="mt-0.5 text-muted-foreground">{String(event.details.reason ?? '')}</p>
                          </div>
                        </li>
                      ))}
                      {reveals.data?.length === 0 && <li className="text-micro text-muted-foreground">No matching audit entries in the retained log.</li>}
                    </ol>
                  ))}
                {canAudit && (
                  <Link
                    to="/settings/audit"
                    search={{ action: 'secret.revealed', q: item.hostname }}
                    className={cn('inline-flex w-fit items-center gap-1 text-micro text-muted-foreground hover:text-foreground')}
                  >
                    <ScrollText className="size-3" />
                    Open in the audit log
                    <ExternalLink className="size-3" />
                  </Link>
                )}
              </section>
              <p className="flex items-start gap-2 rounded-lg bg-surface-2 px-3 py-2 text-micro text-muted-foreground ring-1 ring-border">
                <KeyRound className="mt-0.5 size-3.5 shrink-0" />
                The secret is encrypted on the device to the server’s escrow key and only decrypted in memory when someone reveals it.
              </p>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}

/** Delete with step-up (handled by the client) and a typed confirmation. */
export function DeleteEscrowDialog({ item, onClose }: { item: EscrowItem | null; onClose: () => void }) {
  const queryClient = useQueryClient()
  const remove = useMutation({
    mutationFn: (target: EscrowItem) => escrowApi.remove(target.id),
    meta: { silent: true },
    onSuccess: (_result, target) => {
      toast.success(`Deleted the ${KIND_LABEL[target.kind].toLowerCase()} of ${target.hostname}`)
      void queryClient.invalidateQueries({ queryKey: escrowKeys.all })
      onClose()
    },
    onError: (failure) => toast.error(errorMessage(failure)),
  })
  return (
    <ConfirmDialog
      open={Boolean(item)}
      onOpenChange={(open) => !open && onClose()}
      title={item ? `Delete this ${KIND_LABEL[item.kind].toLowerCase()}?` : 'Delete'}
      description={
        item
          ? `The escrowed ${KIND_LABEL[item.kind].toLowerCase()} of ${item.hostname} (${itemSubject(item)}) is removed permanently and can’t be revealed again. ${item.superseded_at ? '' : 'If it is still the current one, keep another copy or refresh escrow from the device first. '}This is audited.`
          : undefined
      }
      confirmLabel="Delete secret"
      confirmText={item?.hostname}
      pending={remove.isPending}
      onConfirm={() => item && remove.mutate(item)}
    />
  )
}
