import { useCallback, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { ScrollText, Vault } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { EmptyState } from '@/components/common/empty-state'
import { ErrorState } from '@/components/common/misc'
import { PageContainer, PageHeader } from '@/components/common/page-header'
import { escrowItemsQuery } from '@/lib/api/queries'
import type { EscrowItem, EscrowKind } from '@/lib/api/types'
import { KIND_ORDER, KIND_SHORT } from '@/lib/escrow/secret'
import { PERMISSIONS, hasAnyPermission, hasPermission, useMe } from '@/lib/permissions'
import { useScope } from '@/lib/scope'
import { useTitle } from '@/lib/use-title'
import { SearchField } from '@/features/devices/remote-ui'
import { FilterPill } from '@/features/patching/patching-ui'
import { EscrowCoverage } from './escrow-stats'
import { DeleteEscrowDialog, EscrowItemSheet, EscrowTable } from './escrow-table'
import { RevealDialog } from './reveal-dialog'

export interface SecretsSearch {
  kind?: EscrowKind
  q?: string
  superseded?: boolean
  item?: string
}

export function SecretsPage({ search }: { search: SecretsSearch }) {
  useTitle('Secrets')
  const me = useMe()
  const navigate = useNavigate({ from: '/secrets' })
  const { clientId } = useScope()
  const canSee = hasAnyPermission(me, [PERMISSIONS.secretsReveal, PERMISSIONS.secretsManage])
  const canManage = hasPermission(me, PERMISSIONS.secretsManage)
  const canAudit = hasPermission(me, PERMISSIONS.auditView)
  const [query, setQuery] = useState(search.q ?? '')
  const [revealing, setRevealing] = useState<EscrowItem | null>(null)
  const [deleting, setDeleting] = useState<EscrowItem | null>(null)
  const filters = { client_id: clientId, include_superseded: search.superseded || undefined }
  const { data, isLoading, error, refetch } = useQuery({ ...escrowItemsQuery(filters), enabled: canSee })
  const items = useMemo(() => data ?? [], [data])

  const setSearch = useCallback(
    (patch: Partial<SecretsSearch>) => void navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true }),
    [navigate],
  )
  const needle = query.trim().toLowerCase()
  const matches = (item: EscrowItem) => !needle || [item.hostname, item.client_name, item.label, item.identifier].some((value) => value.toLowerCase().includes(needle))
  const searched = items.filter(matches)
  const visible = searched.filter((item) => !search.kind || item.kind === search.kind)
  const selected = search.item ? items.find((item) => item.id === search.item) ?? null : null
  const openItem = useCallback((item: EscrowItem) => setSearch({ item: item.id }), [setSearch])
  const kinds = KIND_ORDER.filter((kind) => kind === 'bitlocker' || kind === 'laps' || items.some((item) => item.kind === kind))

  if (!canSee) {
    return (
      <div className="h-full overflow-y-auto">
        <PageContainer>
          <EmptyState
            illustration="security"
            title="Secrets are restricted"
            description="Escrowed BitLocker keys and local admin passwords need the “Reveal secrets” or “Manage escrow” permission."
          />
        </PageContainer>
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto">
      <PageContainer className="grid grid-cols-1 gap-5">
        <PageHeader
          icon={<Vault />}
          title="Secrets"
          description="BitLocker recovery keys and rotated local administrator passwords, encrypted on each device to the server’s escrow key. Every reveal needs a reason and re-authentication, and is audited."
          actions={
            canAudit && (
              <Button variant="outline" size="sm" render={<Link to="/settings/audit" search={{ action: 'secret' }} />} nativeButton={false}>
                <ScrollText data-icon="inline-start" />
                Secrets audit trail
              </Button>
            )
          }
        />

        {canManage && <EscrowCoverage />}

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap gap-1">
            <FilterPill active={!search.kind} onClick={() => setSearch({ kind: undefined })} count={searched.length}>
              All
            </FilterPill>
            {kinds.map((kind) => (
              <FilterPill key={kind} active={search.kind === kind} onClick={() => setSearch({ kind: search.kind === kind ? undefined : kind })} count={searched.filter((item) => item.kind === kind).length}>
                {KIND_SHORT[kind]}
              </FilterPill>
            ))}
          </div>
          <div className="flex w-full flex-wrap items-center gap-3 sm:ml-auto sm:w-auto">
            <div className="flex items-center gap-2">
              <Switch id="include-superseded" checked={Boolean(search.superseded)} onCheckedChange={(checked) => setSearch({ superseded: checked || undefined })} />
              <Label htmlFor="include-superseded" className="text-dense font-normal text-muted-foreground">
                Include superseded
              </Label>
            </div>
            <SearchField
              value={query}
              onChange={(value) => {
                setQuery(value)
                setSearch({ q: value.trim() || undefined })
              }}
              placeholder="Device, client, volume, account…"
              label="Search secrets"
              className="sm:w-64"
            />
          </div>
        </div>

        {error ? (
          <ErrorState error={error} onRetry={() => void refetch()} />
        ) : !isLoading && items.length === 0 ? (
          <EmptyState
            illustration="security"
            title="Nothing escrowed yet"
            description="Agents escrow BitLocker recovery keys automatically. Enable LAPS in a policy’s Secrets escrow section to rotate and escrow local admin passwords."
            actions={
              <Button variant="outline" size="sm" render={<Link to="/automation/policies" />} nativeButton={false}>
                Open policies
              </Button>
            }
          />
        ) : (
          <EscrowTable
            items={visible}
            loading={isLoading}
            onOpen={openItem}
            onReveal={setRevealing}
            onDelete={setDeleting}
            empty={<div className="px-4 py-10 text-center text-dense text-muted-foreground">No secrets match.</div>}
          />
        )}
      </PageContainer>

      <EscrowItemSheet item={selected} onClose={() => setSearch({ item: undefined })} onReveal={setRevealing} onDelete={setDeleting} />
      <RevealDialog item={revealing} open={Boolean(revealing)} onOpenChange={(open) => !open && setRevealing(null)} />
      <DeleteEscrowDialog
        item={deleting}
        onClose={() => {
          if (deleting && deleting.id === search.item) setSearch({ item: undefined })
          setDeleting(null)
        }}
      />
    </div>
  )
}
