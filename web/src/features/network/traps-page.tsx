import { Fragment, useCallback, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { ChevronRight, Lock, Pencil, Plus, RadioTower, Trash } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { EmptyState } from '@/components/common/empty-state'
import { ErrorState, Mono, RelativeTime } from '@/components/common/misc'
import { PageContainer, PageHeader } from '@/components/common/page-header'
import { SimpleSelect } from '@/components/common/simple-select'
import { snmpApi } from '@/lib/api/endpoints'
import { networkKeys, probesQuery, snmpTrapsQuery, trapRulesQuery } from '@/lib/api/queries'
import type { AlertSeverity, SnmpTrap, TrapRule } from '@/lib/api/types'
import { formatDateTime } from '@/lib/format'
import { SEVERITY_LABEL } from '@/lib/monitoring/labels'
import { formatVarbind, oidMatches, trapName } from '@/lib/network/snmp'
import { PERMISSIONS, hasGlobalPermission, useMe } from '@/lib/permissions'
import { useTitle } from '@/lib/use-title'
import { cn } from '@/lib/utils'
import { SeverityIcon } from '@/features/monitoring/monitoring-ui'
import { SearchField } from '@/features/devices/remote-ui'
import { SiteSelect } from './network-ui'
import { networkErrorMessage, siteLabel, useScopedSites, type SiteOption } from './use-network'

export interface TrapsSearch {
  site_id?: string
  tab?: 'traps' | 'rules'
  q?: string
}

const SEVERITIES: AlertSeverity[] = ['critical', 'warning', 'info']

function TrapRow({ trap, rule, site, expanded, onToggle }: { trap: SnmpTrap; rule?: TrapRule; site?: SiteOption; expanded: boolean; onToggle: () => void }) {
  const name = trapName(trap.oid)
  const summary = trap.varbinds.map((bind) => formatVarbind(bind.value)).filter((value) => value && value !== '—').slice(0, 3).join(' · ')
  return (
    <>
      <tr className="cursor-pointer border-t border-border hover:bg-surface-3/60" onClick={onToggle} aria-expanded={expanded}>
        <td className="px-4 py-2 align-top whitespace-nowrap">
          <span className="flex items-center gap-1.5">
            <ChevronRight className={cn('size-3.5 shrink-0 text-subtle-foreground transition-transform', expanded && 'rotate-90')} />
            <RelativeTime value={trap.at} className="text-muted-foreground" />
          </span>
        </td>
        <td className="px-3 py-2 align-top">
          {trap.snmp_device_id ? (
            <Link to="/network/snmp/$snmpDeviceId" params={{ snmpDeviceId: trap.snmp_device_id }} onClick={(event) => event.stopPropagation()} className="block max-w-48 truncate font-medium hover:underline">
              {trap.snmp_device_name ?? trap.from_ip}
            </Link>
          ) : (
            <span className="block max-w-48 truncate font-mono text-[12px]">{trap.from_ip}</span>
          )}
          <span className="block max-w-48 truncate text-[10.5px] text-subtle-foreground">{trap.snmp_device_id ? trap.from_ip : siteLabel(site)}</span>
        </td>
        <td className="px-3 py-2 align-top">
          <span className="block max-w-64 truncate font-medium">{name ?? 'Trap'}</span>
          <span className="block max-w-64 truncate font-mono text-[10.5px] text-subtle-foreground">{trap.oid}</span>
        </td>
        <td className="px-3 py-2 align-top text-muted-foreground">
          <span className="line-clamp-2 max-w-80 break-words">{summary || '—'}</span>
        </td>
        <td className="px-4 py-2 text-right align-top whitespace-nowrap">
          {trap.alert_id ? (
            <Link to="/alerts" search={{ alert: trap.alert_id, status: 'all' }} onClick={(event) => event.stopPropagation()}>
              <Badge variant={rule?.severity === 'critical' ? 'critical' : rule?.severity === 'warning' ? 'warning' : 'info'}>Alert</Badge>
            </Link>
          ) : rule ? (
            <Badge variant="secondary">{rule.name}</Badge>
          ) : (
            <span className="text-micro text-subtle-foreground">{trap.version}</span>
          )}
        </td>
      </tr>
      {expanded && (
        <tr className="bg-surface-2/60">
          <td colSpan={5} className="px-4 py-3">
            <div className="grid gap-1 text-dense">
              <div className="text-micro text-subtle-foreground">
                {formatDateTime(trap.at)} · {trap.version} · from {trap.from_ip}
                {rule && ` · matched “${rule.name}”`}
              </div>
              {trap.varbinds.length === 0 ? (
                <p className="text-micro text-muted-foreground">No variable bindings.</p>
              ) : (
                <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-[minmax(0,18rem)_1fr]">
                  {trap.varbinds.map((bind, index) => (
                    <Fragment key={index}>
                      <dt className="truncate font-mono text-[11px] text-muted-foreground">{bind.oid}</dt>
                      <dd className="min-w-0 break-words">
                        {formatVarbind(bind.value)}
                        {bind.type && <span className="ml-2 text-micro text-subtle-foreground">{bind.type}</span>}
                      </dd>
                    </Fragment>
                  ))}
                </dl>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

function RuleDialog({ rule, open, onOpenChange, sites }: { rule: TrapRule | null; open: boolean; onOpenChange: (open: boolean) => void; sites: SiteOption[] }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">{open && <RuleForm key={rule?.id ?? 'new'} rule={rule} sites={sites} onDone={() => onOpenChange(false)} />}</DialogContent>
    </Dialog>
  )
}

function RuleForm({ rule, sites, onDone }: { rule: TrapRule | null; sites: SiteOption[]; onDone: () => void }) {
  const queryClient = useQueryClient()
  const probes = useQuery(probesQuery)
  const [name, setName] = useState(rule?.name ?? '')
  const [prefix, setPrefix] = useState(rule?.oid_prefix ?? '')
  const [severity, setSeverity] = useState<AlertSeverity>(rule?.severity ?? 'warning')
  const [title, setTitle] = useState(rule?.title ?? '')
  const [enabled, setEnabled] = useState(rule?.enabled ?? true)
  const [siteIds, setSiteIds] = useState<string[]>(rule?.site_ids ?? [])
  const [attempted, setAttempted] = useState(false)
  const probeSites = sites.filter((site) => probes.data?.some((probe) => probe.site_id === site.id) || siteIds.includes(site.id))
  const errors = {
    name: !name.trim() ? 'Enter a name' : null,
    prefix: !/^\.?\d+(\.\d+)*$/.test(prefix.trim()) ? 'A numeric OID prefix such as 1.3.6.1.4.1.318' : null,
  }
  const save = useMutation({
    mutationFn: () => {
      const body = { name: name.trim(), oid_prefix: prefix.trim().replace(/^\./, ''), severity, title: title.trim(), enabled, site_ids: siteIds }
      return rule ? snmpApi.updateTrapRule(rule.id, body) : snmpApi.createTrapRule(body)
    },
    meta: { silent: true },
    onSuccess: (result) => {
      toast.success(rule ? `Saved “${result.name}”` : `Created “${result.name}”`)
      void queryClient.invalidateQueries({ queryKey: networkKeys.trapRules })
      onDone()
    },
    onError: (failure) => toast.error(networkErrorMessage(failure)),
  })
  const known = trapName(prefix.trim())
  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        setAttempted(true)
        if (!errors.name && !errors.prefix) save.mutate()
      }}
    >
      <DialogHeader>
        <DialogTitle>{rule ? 'Edit trap rule' : 'New trap rule'}</DialogTitle>
        <DialogDescription>A trap whose OID starts with the prefix (on an arc boundary) raises an alert. The most specific enabled rule wins; each matching trap adds an occurrence.</DialogDescription>
      </DialogHeader>
      <Field data-invalid={(attempted && Boolean(errors.name)) || undefined}>
        <FieldLabel htmlFor="rule-name">Name</FieldLabel>
        <Input id="rule-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="UPS on battery" />
        {attempted && errors.name && <FieldError>{errors.name}</FieldError>}
      </Field>
      <div className="grid gap-3 sm:grid-cols-[1fr_9rem]">
        <Field data-invalid={(attempted && Boolean(errors.prefix)) || undefined}>
          <FieldLabel htmlFor="rule-prefix">OID prefix</FieldLabel>
          <Input id="rule-prefix" value={prefix} onChange={(event) => setPrefix(event.target.value)} className="font-mono text-[12.5px]" placeholder="1.3.6.1.4.1.318.0.5" spellCheck={false} />
          {attempted && errors.prefix ? <FieldError>{errors.prefix}</FieldError> : known ? <FieldDescription>{known}</FieldDescription> : null}
        </Field>
        <Field>
          <FieldLabel htmlFor="rule-severity">Severity</FieldLabel>
          <SimpleSelect id="rule-severity" value={severity} onValueChange={(value) => setSeverity(value as AlertSeverity)} options={SEVERITIES.map((value) => ({ value, label: SEVERITY_LABEL[value] }))} />
        </Field>
      </div>
      <Field>
        <FieldLabel htmlFor="rule-title">Alert title</FieldLabel>
        <Input id="rule-title" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="UPS switched to battery" />
        <FieldDescription>Shown after the device name, e.g. “Data room UPS: UPS switched to battery”.</FieldDescription>
      </Field>
      <Field>
        <FieldLabel>Sites</FieldLabel>
        <div className="grid max-h-40 gap-0.5 overflow-y-auto">
          {probeSites.map((site) => (
            <label key={site.id} className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-dense hover:bg-surface-3">
              <Checkbox checked={siteIds.includes(site.id)} onCheckedChange={(checked) => setSiteIds(checked ? [...siteIds, site.id] : siteIds.filter((id) => id !== site.id))} />
              <span className="truncate">{siteLabel(site)}</span>
            </label>
          ))}
        </div>
        <FieldDescription>{siteIds.length === 0 ? 'No site selected: the rule applies to every site.' : `Applies to ${siteIds.length} ${siteIds.length === 1 ? 'site' : 'sites'}.`}</FieldDescription>
      </Field>
      <div className="flex items-center gap-3">
        <Switch id="rule-enabled" checked={enabled} onCheckedChange={setEnabled} />
        <label htmlFor="rule-enabled" className="text-dense">
          Enabled
        </label>
      </div>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onDone} disabled={save.isPending}>
          Cancel
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending && <Spinner data-icon="inline-start" />}
          {rule ? 'Save rule' : 'Create rule'}
        </Button>
      </DialogFooter>
    </form>
  )
}

export function TrapsPage({ search }: { search: TrapsSearch }) {
  useTitle('Traps')
  const me = useMe()
  const navigate = useNavigate({ from: '/network/traps' })
  const queryClient = useQueryClient()
  const canEdit = hasGlobalPermission(me, PERMISSIONS.networkManage)
  const { sites, byId } = useScopedSites()
  const traps = useQuery(snmpTrapsQuery(search.site_id, 300))
  const rules = useQuery(trapRulesQuery)
  const [query, setQuery] = useState(search.q ?? '')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [editing, setEditing] = useState<TrapRule | null>(null)
  const [creating, setCreating] = useState(false)
  const [deleting, setDeleting] = useState<TrapRule | null>(null)
  const setSearch = useCallback((patch: Partial<TrapsSearch>) => void navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true }), [navigate])
  const tab = search.tab ?? 'traps'

  const needle = query.trim().toLowerCase()
  const visible = useMemo(
    () =>
      (traps.data ?? [])
        .filter((trap) => byId.has(trap.site_id))
        .filter((trap) => !needle || [trap.oid, trap.from_ip, trap.snmp_device_name ?? '', trapName(trap.oid) ?? '', ...trap.varbinds.map((bind) => formatVarbind(bind.value))].some((value) => value.toLowerCase().includes(needle))),
    [traps.data, byId, needle],
  )
  const ruleFor = (trap: SnmpTrap) => rules.data?.find((rule) => rule.id === trap.rule_id)

  const toggle = useMutation({
    mutationFn: (rule: TrapRule) => snmpApi.updateTrapRule(rule.id, { name: rule.name, enabled: !rule.enabled, oid_prefix: rule.oid_prefix, severity: rule.severity, site_ids: rule.site_ids, title: rule.title }),
    meta: { silent: true },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: networkKeys.trapRules }),
    onError: (failure) => toast.error(networkErrorMessage(failure)),
  })
  const remove = useMutation({
    mutationFn: (rule: TrapRule) => snmpApi.removeTrapRule(rule.id),
    meta: { silent: true },
    onSuccess: (_result, rule) => {
      toast.success(`Deleted “${rule.name}”`)
      setDeleting(null)
      void queryClient.invalidateQueries({ queryKey: networkKeys.trapRules })
    },
    onError: (failure) => toast.error(networkErrorMessage(failure)),
  })

  return (
    <PageContainer className="grid grid-cols-1 gap-4">
      <PageHeader
        icon={<RadioTower />}
        title="Traps"
        description="SNMP traps the probes received (v1 and v2c, kept 90 days). Trap rules turn matching traps into alerts."
        actions={
          canEdit &&
          tab === 'rules' && (
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus data-icon="inline-start" />
              New rule
            </Button>
          )
        }
      />
      <Tabs value={tab} onValueChange={(value) => setSearch({ tab: value === 'traps' ? undefined : (value as 'rules') })} className="gap-4">
        <div className="-mx-4 [scrollbar-width:none] overflow-x-auto border-b border-border px-4 sm:-mx-6 sm:px-6">
          <TabsList variant="line" className="-mb-px h-10 w-max gap-4">
            <TabsTrigger value="traps" className="flex-none px-0">
              Received
              <span className="tabular text-micro text-subtle-foreground">{visible.length}</span>
            </TabsTrigger>
            <TabsTrigger value="rules" className="flex-none px-0">
              Rules
              <span className="tabular text-micro text-subtle-foreground">{rules.data?.length ?? 0}</span>
            </TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="traps" className="grid gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <SiteSelect value={search.site_id ?? ''} onChange={(value) => setSearch({ site_id: value || undefined })} sites={sites} />
            <SearchField
              value={query}
              onChange={(value) => {
                setQuery(value)
                setSearch({ q: value.trim() || undefined })
              }}
              placeholder="OID, sender, device, value…"
              label="Search traps"
              className="sm:ml-auto sm:w-64"
            />
          </div>
          {traps.error ? (
            <ErrorState error={traps.error} onRetry={() => void traps.refetch()} />
          ) : traps.isLoading ? (
            <Skeleton className="h-64 rounded-xl" />
          ) : visible.length === 0 ? (
            <EmptyState illustration="network" title="No traps" description="Enable the trap receiver on a site’s probe (Network › Probes) and point devices’ trap destination at it." compact />
          ) : (
            <div className="overflow-x-auto rounded-xl bg-card shadow-card">
              <table className="font-condensed w-full min-w-[760px] text-dense">
                <thead>
                  <tr className="bg-surface-2/95 text-left text-micro font-semibold tracking-[0.06em] text-subtle-foreground uppercase">
                    <th className="h-9 px-4">Received</th>
                    <th className="px-3">From</th>
                    <th className="px-3">Trap</th>
                    <th className="px-3">Details</th>
                    <th className="px-4 text-right">Rule</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((trap) => (
                    <TrapRow key={trap.id} trap={trap} rule={ruleFor(trap)} site={byId.get(trap.site_id)} expanded={expanded === trap.id} onToggle={() => setExpanded(expanded === trap.id ? null : trap.id)} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </TabsContent>
        <TabsContent value="rules" className="grid gap-3">
          {!canEdit && (
            <p className="flex items-start gap-2 rounded-xl bg-surface-2 px-4 py-3 text-dense text-muted-foreground ring-1 ring-border">
              <Lock className="mt-0.5 size-4 shrink-0" />
              Trap rules are installation-wide; changing them needs the “Manage network” permission held globally.
            </p>
          )}
          {rules.error ? (
            <ErrorState error={rules.error} onRetry={() => void rules.refetch()} />
          ) : rules.isLoading ? (
            <Skeleton className="h-40 rounded-xl" />
          ) : (rules.data ?? []).length === 0 ? (
            <EmptyState illustration="alerts" title="No trap rules" description="Without rules, traps are only listed. Add one to alert on, for example, a UPS switching to battery." compact />
          ) : (
            <ul className="grid gap-2">
              {(rules.data ?? []).map((rule) => {
                const matched = (traps.data ?? []).filter((trap) => trap.rule_id === rule.id || (rule.enabled && oidMatches(rule.oid_prefix, trap.oid))).length
                return (
                  <li key={rule.id} className={cn('flex flex-wrap items-center gap-3 rounded-xl bg-card px-4 py-3 shadow-card', !rule.enabled && 'opacity-70')}>
                    <Switch checked={rule.enabled} disabled={!canEdit || toggle.isPending} aria-label={`${rule.enabled ? 'Disable' : 'Enable'} ${rule.name}`} onCheckedChange={() => toggle.mutate(rule)} />
                    <SeverityIcon severity={rule.severity} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-dense font-semibold">{rule.name}</span>
                        <Mono className="text-[10.5px]">{rule.oid_prefix}</Mono>
                        {trapName(rule.oid_prefix) && <span className="text-micro text-subtle-foreground">{trapName(rule.oid_prefix)}</span>}
                      </div>
                      <p className="truncate text-micro text-muted-foreground">
                        {SEVERITY_LABEL[rule.severity]} · “{rule.title || rule.name}” · {rule.site_ids.length === 0 ? 'every site' : rule.site_ids.map((id) => byId.get(id)?.name ?? 'site').join(', ')} · {matched} recent {matched === 1 ? 'trap' : 'traps'}
                      </p>
                    </div>
                    {canEdit && (
                      <div className="flex gap-1">
                        <Button variant="outline" size="xs" onClick={() => setEditing(rule)}>
                          <Pencil data-icon="inline-start" />
                          Edit
                        </Button>
                        <Button variant="ghost" size="icon-xs" aria-label={`Delete ${rule.name}`} className="hover:text-critical" onClick={() => setDeleting(rule)}>
                          <Trash />
                        </Button>
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </TabsContent>
      </Tabs>
      <RuleDialog rule={editing} sites={sites} open={creating || Boolean(editing)} onOpenChange={(open) => !open && (setCreating(false), setEditing(null))} />
      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete “${deleting?.name}”?`}
        description="Matching traps are still received and listed, but no longer raise alerts."
        pending={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
      />
    </PageContainer>
  )
}
