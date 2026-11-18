/* A compact ticket table for client, device and contact pages. */
import { useMemo } from 'react'
import { useNavigate } from '@tanstack/react-router'
import type { ColumnDef } from '@tanstack/react-table'
import { DataTable } from '@/components/common/data-table'
import { RelativeTime, UserAvatar } from '@/components/common/misc'
import type { Ticket } from '@/lib/api/types'
import { PRIORITY_RANK, ticketNumber } from '@/lib/tickets/labels'
import { PriorityGlyph, SlaChip, TicketStatusBadge } from './ticket-ui'

export function TicketTable({ tickets, hideClient = false, loading = false }: { tickets: Ticket[]; hideClient?: boolean; loading?: boolean }) {
  const navigate = useNavigate()
  const columns = useMemo<ColumnDef<Ticket>[]>(
    () => [
      {
        id: 'number',
        accessorKey: 'number',
        header: '#',
        cell: ({ row }) => <span className="tabular font-mono text-[11.5px] text-muted-foreground">{ticketNumber(row.original.number)}</span>,
      },
      {
        id: 'subject',
        accessorKey: 'subject',
        header: 'Subject',
        cell: ({ row }) => (
          <span className="flex min-w-0 items-center gap-2">
            <PriorityGlyph priority={row.original.priority} />
            <span className="min-w-0">
              <span className="block max-w-[28rem] truncate font-medium">{row.original.subject}</span>
              <span className="block truncate text-micro text-muted-foreground">
                {[hideClient ? null : row.original.client_name, row.original.contact?.name, row.original.queue.name].filter(Boolean).join(' · ')}
              </span>
            </span>
          </span>
        ),
      },
      {
        id: 'status',
        accessorKey: 'status',
        header: 'Status',
        cell: ({ row }) => (
          <span className="flex items-center gap-1.5">
            <TicketStatusBadge status={row.original.status} />
            <SlaChip ticket={row.original} />
          </span>
        ),
      },
      {
        id: 'priority',
        accessorFn: (ticket) => PRIORITY_RANK[ticket.priority],
        header: 'Priority',
        cell: ({ row }) => <span className="capitalize text-muted-foreground">{row.original.priority}</span>,
      },
      {
        id: 'assignee',
        accessorFn: (ticket) => ticket.assignee?.name ?? '',
        header: 'Assignee',
        cell: ({ row }) =>
          row.original.assignee ? (
            <span className="flex items-center gap-1.5 whitespace-nowrap">
              <UserAvatar name={row.original.assignee.name} size="xs" />
              {row.original.assignee.name}
            </span>
          ) : (
            <span className="text-subtle-foreground">Unassigned</span>
          ),
      },
      {
        id: 'last_activity_at',
        accessorKey: 'last_activity_at',
        header: 'Activity',
        cell: ({ row }) => <RelativeTime value={row.original.last_activity_at} className="text-muted-foreground" />,
      },
    ],
    [hideClient],
  )
  return (
    <DataTable
      data={tickets}
      columns={columns}
      loading={loading}
      getRowId={(row) => row.id}
      onRowClick={(row) => void navigate({ to: '/tickets/$ticketId', params: { ticketId: row.id } })}
      initialSorting={[{ id: 'last_activity_at', desc: true }]}
    />
  )
}
