import { useMemo, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import type { ColumnDef } from '@tanstack/react-table'
import {
  ArrowUpRight,
  Ban,
  Check,
  Copy,
  Download,
  Ellipsis,
  Inbox,
  KeyRound,
  Network,
  Package,
  Plus,
  RotateCw,
  Rocket,
  ShieldCheck,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Can } from '@/components/common/can'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { CopyButton } from '@/components/common/copy-button'
import { DataTable } from '@/components/common/data-table'
import { EmptyState } from '@/components/common/empty-state'
import { ErrorState, Mono, RelativeTime } from '@/components/common/misc'
import { OsIcon } from '@/components/common/os-icon'
import { PageContainer, PageHeader } from '@/components/common/page-header'
import { SimpleSelect } from '@/components/common/simple-select'
import { copyText } from '@/lib/clipboard'
import { devicesApi, enrollmentApi } from '@/lib/api/endpoints'
import { devicesQuery, enrollmentQuery, keys } from '@/lib/api/queries'
import type { AgentArtifact, Device, EnrollmentToken, InstallerKind, TokenStatus } from '@/lib/api/types'
import { daysUntil, tokenUsage } from '@/lib/deploy'
import { deviceName } from '@/lib/devices'
import { formatBytes, formatNumber } from '@/lib/format'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'
import { useScope } from '@/lib/scope'
import { useTitle } from '@/lib/use-title'
import { cn } from '@/lib/utils'
import { NewDeployKeyDialog } from './deploy-key-dialog'
import { UsageBar } from './device-ui'
import { InstallerIcon } from './installer-downloads'
import { INSTALLERS, useInstallerDownload } from './installers'
import { DevicesContextPanel } from './devices-context'

export interface DeploySearch {
  section?: 'keys' | 'install' | 'gpo' | 'approvals'
  new?: boolean
}

const STATUS_BADGE: Record<TokenStatus, { label: string; variant: 'live' | 'outline' | 'warning' | 'secondary' }> = {
  active: { label: 'Active', variant: 'live' },
  revoked: { label: 'Revoked', variant: 'outline' },
  expired: { label: 'Expired', variant: 'warning' },
  exhausted: { label: 'Used up', variant: 'secondary' },
}

function expiryLabel(token: EnrollmentToken) {
  if (token.status === 'revoked') return { text: '—', tone: 'text-subtle-foreground' }
  const days = daysUntil(token.expires_at)
  if (days === null) return { text: 'Never', tone: 'text-muted-foreground' }
  if (days <= 0) return { text: `Expired ${Math.abs(days) === 0 ? 'today' : `${Math.abs(days)}d ago`}`, tone: 'text-subtle-foreground' }
  if (days <= 3) return { text: `in ${days} ${days === 1 ? 'day' : 'days'}`, tone: 'text-warning' }
  return { text: `in ${days} days`, tone: 'text-muted-foreground' }
}

// ------------------------------------------------------------------ shared bits

function CodeBlock({ code, label }: { code: string; label: string }) {
  return (
    <div className="group relative">
      <pre className="overflow-x-auto rounded-lg bg-surface-0 px-3 py-2.5 pr-10 font-mono text-[12px] leading-relaxed text-secondary-foreground ring-1 ring-border dark:bg-black/30">
        <code>{code}</code>
      </pre>
      <CopyButton value={code} label={`Copy ${label}`} className="absolute top-1.5 right-1.5 bg-card/90 shadow-raised backdrop-blur" />
    </div>
  )
}

function Steps({ children }: { children: ReactNode }) {
  return <ol className="grid gap-3 [counter-reset:step]">{children}</ol>
}

function Step({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <li className="relative grid gap-1.5 pl-9 [counter-increment:step] before:absolute before:top-0 before:left-0 before:flex before:size-6 before:items-center before:justify-center before:rounded-full before:bg-primary/12 before:font-mono before:text-[11px] before:font-semibold before:text-primary before:ring-1 before:ring-primary/25 before:content-[counter(step)]">
      <div className="pt-0.5 text-dense font-medium">{title}</div>
      {children && <div className="grid gap-2 text-dense text-muted-foreground">{children}</div>}
    </li>
  )
}

function KeyPicker({
  tokens,
  value,
  onChange,
}: {
  tokens: EnrollmentToken[]
  value: string | null
  onChange: (id: string) => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl bg-card p-3 shadow-card">
      <span className="flex size-8 items-center justify-center rounded-lg bg-primary/12 text-primary ring-1 ring-primary/25">
        <KeyRound className="size-4" />
      </span>
      <div className="min-w-0 flex-1 basis-48">
        <p className="text-dense font-medium">Deploy key</p>
        <p className="text-micro text-muted-foreground">Installers embed the key, so devices land in its client and site.</p>
      </div>
      <SimpleSelect
        className="w-full sm:w-80"
        ariaLabel="Deploy key"
        value={value}
        onValueChange={onChange}
        placeholder="Choose a deploy key…"
        options={tokens.map((token) => ({ value: token.id, label: `${token.name} — ${token.client_name} / ${token.site_name}`, group: token.client_name }))}
      />
    </div>
  )
}

function NoActiveKey({ onCreate }: { onCreate: () => void }) {
  return (
    <EmptyState
      compact
      illustration="launch"
      title="Create a deploy key first"
      description="Installers are generated per deploy key, so every device lands in the right client and site."
      actions={
        <Can permission={PERMISSIONS.agentsDeploy}>
          <Button size="sm" onClick={onCreate}>
            <Plus data-icon="inline-start" />
            New deploy key
          </Button>
        </Can>
      }
    />
  )
}

function DownloadButton({ tokenId, kind, label, variant = 'outline' }: { tokenId: string | null; kind: InstallerKind; label: string; variant?: 'outline' | 'default' }) {
  const { download, isPending } = useInstallerDownload()
  const pending = tokenId ? isPending(tokenId, kind) : false
  return (
    <Button size="sm" variant={variant} disabled={!tokenId || pending} onClick={() => tokenId && void download(tokenId, kind)}>
      {pending ? <Spinner data-icon="inline-start" /> : <Download data-icon="inline-start" />}
      {label}
    </Button>
  )
}

// ------------------------------------------------------------------ keys

function KeysTab({ tokens, loading, onCreate }: { tokens: EnrollmentToken[]; loading: boolean; onCreate: () => void }) {
  const queryClient = useQueryClient()
  const me = useMe()
  const canDeploy = hasPermission(me, PERMISSIONS.agentsDeploy)
  const { download } = useInstallerDownload()
  const [revoking, setRevoking] = useState<EnrollmentToken | null>(null)

  const revoke = useMutation({
    mutationFn: (token: EnrollmentToken) => enrollmentApi.revoke(token.id),
    meta: { successMessage: 'Deploy key revoked' },
    onSuccess: () => {
      setRevoking(null)
      void queryClient.invalidateQueries({ queryKey: keys.enrollment })
    },
  })

  async function copyKey(token: EnrollmentToken) {
    try {
      const { deploy_key } = await enrollmentApi.deployKey(token.id)
      if (await copyText(deploy_key)) toast.success(`Copied the deploy key for ${token.name}`)
      else toast.error('Clipboard access was blocked by the browser.')
    } catch {
      toast.error('Could not fetch the deploy key.')
    }
  }

  const columns = useMemo<ColumnDef<EnrollmentToken>[]>(
    () => [
      {
        id: 'name',
        accessorFn: (token) => token.name.toLowerCase(),
        header: 'Deploy key',
        cell: ({ row }) => (
          <div className="min-w-0 leading-tight">
            <div className={cn('max-w-64 truncate font-medium', row.original.status !== 'active' && 'text-muted-foreground')}>{row.original.name}</div>
            <div className="max-w-64 truncate text-[10.5px] text-subtle-foreground">
              {row.original.client_name} / {row.original.site_name}
            </div>
          </div>
        ),
      },
      {
        id: 'status',
        accessorFn: (token) => token.status,
        header: 'Status',
        cell: ({ row }) => <Badge variant={STATUS_BADGE[row.original.status].variant}>{STATUS_BADGE[row.original.status].label}</Badge>,
      },
      {
        id: 'mode',
        accessorFn: (token) => (token.require_approval ? 1 : 0),
        header: 'Enrollment',
        cell: ({ row }) =>
          row.original.require_approval ? (
            <span className="inline-flex items-center gap-1.5 text-info">
              <ShieldCheck className="size-3.5" />
              Approval
            </span>
          ) : (
            <span className="text-muted-foreground">Automatic</span>
          ),
      },
      {
        id: 'usage',
        accessorFn: (token) => token.uses,
        header: 'Used',
        cell: ({ row }) => {
          const usage = tokenUsage(row.original)
          return (
            <div className="grid w-28 gap-1">
              <span className="tabular text-dense">{usage.label}</span>
              {usage.pct !== null && <UsageBar value={usage.pct} height="h-[3px]" />}
            </div>
          )
        },
      },
      {
        id: 'expires',
        accessorFn: (token) => (token.expires_at ? new Date(token.expires_at).getTime() : Number.MAX_SAFE_INTEGER),
        header: 'Expires',
        cell: ({ row }) => {
          const label = expiryLabel(row.original)
          return <span className={cn('tabular', label.tone)}>{label.text}</span>
        },
      },
      {
        id: 'restrictions',
        enableSorting: false,
        header: 'Restricted to',
        cell: ({ row }) => {
          const items = [...row.original.allowed_domains, ...row.original.allowed_cidrs]
          if (items.length === 0) return <span className="text-subtle-foreground">Anywhere</span>
          return (
            <Tooltip>
              <TooltipTrigger render={<span className="inline-flex max-w-48 items-center gap-1.5 truncate font-mono text-[11px] text-muted-foreground" />}>
                <Network className="size-3 shrink-0" />
                <span className="truncate">{items[0]}</span>
                {items.length > 1 && <span className="text-subtle-foreground">+{items.length - 1}</span>}
              </TooltipTrigger>
              <TooltipContent className="grid gap-0.5 font-mono">
                {items.map((item) => (
                  <span key={item}>{item}</span>
                ))}
              </TooltipContent>
            </Tooltip>
          )
        },
      },
      {
        id: 'last_used',
        accessorFn: (token) => token.last_used_at ?? '',
        header: 'Last used',
        cell: ({ row }) => <RelativeTime value={row.original.last_used_at} className="text-muted-foreground" />,
      },
      {
        id: 'actions',
        enableSorting: false,
        header: () => <span className="sr-only">Actions</span>,
        meta: { align: 'right' },
        cell: ({ row }) => {
          const token = row.original
          const active = token.status === 'active'
          return (
            <span onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" aria-label={`Actions for ${token.name}`} />}>
                  <Ellipsis />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  {active ? (
                    <>
                      <DropdownMenuGroup>
                        <DropdownMenuItem onClick={() => void copyKey(token)}>
                          <Copy />
                          Copy deploy key
                        </DropdownMenuItem>
                      </DropdownMenuGroup>
                      <DropdownMenuSeparator />
                      <DropdownMenuGroup>
                        <DropdownMenuLabel>Download installer</DropdownMenuLabel>
                        {INSTALLERS.map((item) => (
                          <DropdownMenuItem key={item.kind} onClick={() => void download(token.id, item.kind)}>
                            <InstallerIcon kind={item.kind} />
                            {item.label}
                            <span className="ml-auto text-micro text-subtle-foreground">{item.hint}</span>
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuGroup>
                      {canDeploy && (
                        <>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem variant="destructive" onClick={() => setRevoking(token)}>
                            <Ban />
                            Revoke key…
                          </DropdownMenuItem>
                        </>
                      )}
                    </>
                  ) : (
                    <DropdownMenuGroup>
                      <DropdownMenuLabel>This key can no longer enroll devices</DropdownMenuLabel>
                    </DropdownMenuGroup>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </span>
          )
        },
      },
    ],
    [canDeploy, download],
  )

  return (
    <div className="grid gap-3 [&>*]:min-w-0">
      {!loading && tokens.length === 0 ? (
        <EmptyState
          illustration="launch"
          title="No deploy keys yet"
          description="A deploy key ties new agents to a client and site. Create one, then download an installer or set up Group Policy."
          actions={
            <Can permission={PERMISSIONS.agentsDeploy}>
              <Button onClick={onCreate}>
                <Plus data-icon="inline-start" />
                New deploy key
              </Button>
            </Can>
          }
        />
      ) : (
        <DataTable
          data={tokens}
          columns={columns}
          loading={loading}
          getRowId={(token) => token.id}
          initialSorting={[{ id: 'status', desc: false }]}
          caption="Deploy keys"
          rowClassName={(token) => token.status !== 'active' && 'opacity-75'}
        />
      )}
      <ConfirmDialog
        open={Boolean(revoking)}
        onOpenChange={(open) => !open && setRevoking(null)}
        title={`Revoke “${revoking?.name}”?`}
        description="New enrollments with this key are refused immediately, including installers you've already handed out. Devices that already enrolled keep working."
        confirmLabel="Revoke key"
        pending={revoke.isPending}
        onConfirm={() => revoking && revoke.mutate(revoking)}
      />
    </div>
  )
}

// ------------------------------------------------------------------ install

function ArtifactsCard({ artifacts }: { artifacts: AgentArtifact[] }) {
  return (
    <Card size="sm" className="gap-0 py-0">
      <CardHeader className="border-b border-border py-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Package className="size-4 text-subtle-foreground" />
          Agent builds on this server
        </CardTitle>
        <CardDescription>Installers download these files and verify their SHA-256 before running them.</CardDescription>
      </CardHeader>
      {artifacts.length === 0 ? (
        <div className="p-4">
          <EmptyState
            compact
            illustration="software"
            title="No agent builds found"
            description="Build the agent for each platform and copy the binaries into the server's agent directory. Installers can't run until a matching build is available."
          />
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {artifacts.map((artifact) => {
            const family = artifact.platform.startsWith('windows') ? 'windows' : artifact.platform.startsWith('macos') ? 'macos' : 'linux'
            return (
              <li key={`${artifact.platform}-${artifact.file}`} className="grid grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-1 px-4 py-2.5 sm:grid-cols-[auto_minmax(0,1fr)_auto_minmax(0,16rem)]">
                <OsIcon family={family} className="size-4" />
                <div className="min-w-0">
                  <div className="truncate text-dense font-medium">{artifact.label}</div>
                  <div className="truncate font-mono text-[10.5px] text-subtle-foreground">{artifact.file}</div>
                </div>
                <span className="tabular text-micro text-muted-foreground">{formatBytes(artifact.size_bytes)}</span>
                <span className="col-span-3 flex min-w-0 items-center gap-1 sm:col-span-1">
                  <span className="text-micro text-subtle-foreground">SHA-256</span>
                  <Mono truncate={8} className="min-w-0">
                    {artifact.sha256}
                  </Mono>
                  <CopyButton value={artifact.sha256} label={`Copy SHA-256 of ${artifact.label}`} />
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </Card>
  )
}

function PlatformCard({
  icon,
  title,
  description,
  children,
  footer,
}: {
  icon: ReactNode
  title: string
  description: string
  children: ReactNode
  footer: ReactNode
}) {
  return (
    <Card size="sm" className="gap-3">
      <CardHeader className="flex flex-row items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-surface-2 shadow-raised ring-1 ring-border [&_svg]:size-4">{icon}</span>
        <div className="min-w-0">
          <CardTitle className="text-sm">{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="grid min-w-0 gap-3 [&>*]:min-w-0">
        {children}
        <div className="flex flex-wrap gap-2">{footer}</div>
      </CardContent>
    </Card>
  )
}

function InstallTab({
  activeTokens,
  selected,
  onSelect,
  artifacts,
  onCreate,
}: {
  activeTokens: EnrollmentToken[]
  selected: string | null
  onSelect: (id: string) => void
  artifacts: AgentArtifact[]
  onCreate: () => void
}) {
  const msiName = artifacts.find((artifact) => artifact.file.toLowerCase().endsWith('.msi'))?.file ?? 'RustRMMAgent.msi'
  return (
    <div className="grid gap-4">
      {activeTokens.length === 0 ? (
        <NoActiveKey onCreate={onCreate} />
      ) : (
        <>
          <KeyPicker tokens={activeTokens} value={selected} onChange={onSelect} />
          <div className="grid gap-4 lg:grid-cols-2">
            <PlatformCard
              icon={<OsIcon family="windows" />}
              title="Windows — one-line script"
              description="Workstations and servers. Run from an elevated PowerShell prompt."
              footer={<DownloadButton tokenId={selected} kind="powershell" label="Download PowerShell script" variant="default" />}
            >
              <CodeBlock label="Windows command" code={'powershell -NoProfile -ExecutionPolicy Bypass -File .\\install-rustrmm.ps1'} />
              <p className="text-micro text-muted-foreground">Downloads the agent from this server, installs it as a Windows service and enrolls it. Safe to run again.</p>
            </PlatformCard>
            <PlatformCard
              icon={<OsIcon family="windows" />}
              title="Windows — MSI with deploy.key"
              description="For RMM-less imaging, Intune or Group Policy Software Installation."
              footer={
                <>
                  <DownloadButton tokenId={selected} kind="deploy-key" label="Download deploy.key" variant="default" />
                </>
              }
            >
              <CodeBlock label="MSI command" code={`msiexec /i ${msiName} /qn /norestart`} />
              <p className="text-micro text-muted-foreground">
                Put <span className="font-mono text-foreground">deploy.key</span> in the same folder as the MSI; the installer picks it up automatically.
              </p>
            </PlatformCard>
            <PlatformCard
              icon={<OsIcon family="linux" />}
              title="Linux"
              description="systemd-based distributions such as Ubuntu, Debian and RHEL. Run as root."
              footer={<DownloadButton tokenId={selected} kind="linux" label="Download shell script" variant="default" />}
            >
              <CodeBlock label="Linux command" code={'sudo sh ./install-rustrmm.sh'} />
              <p className="text-micro text-muted-foreground">Installs the agent as a systemd service and enrolls it.</p>
            </PlatformCard>
            <PlatformCard
              icon={<OsIcon family="macos" />}
              title="macOS"
              description="Apple silicon and Intel Macs. Run as an administrator."
              footer={<DownloadButton tokenId={selected} kind="macos" label="Download shell script" variant="default" />}
            >
              <CodeBlock label="macOS command" code={'sudo sh ./install-rustrmm-macos.sh'} />
              <p className="text-micro text-muted-foreground">
                Installs the agent as a launchd daemon. Grant it Full Disk Access through your MDM for complete inventory.
              </p>
            </PlatformCard>
          </div>
        </>
      )}
      <ArtifactsCard artifacts={artifacts} />
    </div>
  )
}

// ------------------------------------------------------------------ group policy

function GpoTab({
  activeTokens,
  selected,
  onSelect,
  onCreate,
}: {
  activeTokens: EnrollmentToken[]
  selected: string | null
  onSelect: (id: string) => void
  onCreate: () => void
}) {
  return (
    <div className="grid gap-4">
      {activeTokens.length === 0 ? <NoActiveKey onCreate={onCreate} /> : <KeyPicker tokens={activeTokens} value={selected} onChange={onSelect} />}
      <div className="grid gap-4 xl:grid-cols-2">
        <Card size="sm" className="gap-4">
          <CardHeader>
            <div className="flex items-center gap-2">
              <Badge variant="default">Option A</Badge>
              <Badge variant="outline">Recommended</Badge>
            </div>
            <CardTitle className="text-base">Software Installation (MSI)</CardTitle>
            <CardDescription>Installs silently at boot, before anyone signs in. Group Policy tracks and can remove the package.</CardDescription>
          </CardHeader>
          <CardContent>
            <Steps>
              <Step title="Download the MSI and the deploy.key for the target site">
                <div className="flex flex-wrap gap-2">
                  <DownloadButton tokenId={selected} kind="deploy-key" label="deploy.key" />
                </div>
                <span>The MSI is listed under Agent builds on the Install tab.</span>
              </Step>
              <Step title="Copy both files into one share that Domain Computers can read">
                <CodeBlock label="share path" code={'\\\\fs01\\deploy$\\RustRMM\\'} />
                <span>Grant read access to Domain Computers, not only to users — the install runs as SYSTEM.</span>
              </Step>
              <Step title="Create a GPO and link it to the OU that holds the computers">
                Group Policy Management › right-click the OU › Create a GPO in this domain, and Link it here.
              </Step>
              <Step title="Assign the package">
                Computer Configuration › Policies › Software Settings › Software installation › New › Package. Pick the MSI through its UNC path
                (not a mapped drive) and choose Assigned.
              </Step>
              <Step title="Restart the computers">
                The agent installs during the next boot, reads deploy.key next to the MSI and enrolls. Devices appear here within a minute.
              </Step>
            </Steps>
          </CardContent>
        </Card>

        <Card size="sm" className="gap-4">
          <CardHeader>
            <div className="flex items-center gap-2">
              <Badge variant="secondary">Option B</Badge>
            </div>
            <CardTitle className="text-base">Computer startup script</CardTitle>
            <CardDescription>Works with any share layout and re-runs safely on every boot — useful when Software Installation is blocked.</CardDescription>
          </CardHeader>
          <CardContent>
            <Steps>
              <Step title="Download the Group Policy script">
                <div className="flex flex-wrap gap-2">
                  <DownloadButton tokenId={selected} kind="gpo" label="Install-RustRMM.ps1" />
                </div>
                <span>The deploy key is embedded in the script. Place the MSI next to it.</span>
              </Step>
              <Step title="Copy the script and the MSI to a share readable by Domain Computers" />
              <Step title="Add the startup script">
                Computer Configuration › Policies › Windows Settings › Scripts (Startup/Shutdown) › Startup › PowerShell Scripts › Add, and browse to
                the script on the share.
              </Step>
              <Step title="Wait for the network at startup (recommended)">
                Computer Configuration › Policies › Administrative Templates › System › Logon › Always wait for the network at computer startup and logon
                › Enabled.
              </Step>
              <Step title="Restart the computers">
                The script runs on every boot and skips machines where the agent is already installed.
              </Step>
            </Steps>
          </CardContent>
        </Card>
      </div>

      <Card size="sm" className="gap-3">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <ShieldCheck className="size-4 text-subtle-foreground" />
            Hardening tips
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="grid gap-2 text-dense text-muted-foreground sm:grid-cols-2">
            <li>• Restrict the key to your AD domain and office networks so a leaked copy is useless elsewhere.</li>
            <li>• Use “Require approval” for keys that leave IT, and an expiry that matches the rollout window.</li>
            <li>• Revoke the key after the rollout; enrolled devices keep working.</li>
            <li>• Signing the agent is optional. Unsigned builds deploy fine through Group Policy; signed builds avoid SmartScreen prompts for manual installs.</li>
          </ul>
        </CardContent>
      </Card>
    </div>
  )
}

// ------------------------------------------------------------------ approvals

function ApprovalsTab({ devices, loading, canApprove }: { devices: Device[]; loading: boolean; canApprove: boolean }) {
  const queryClient = useQueryClient()
  const [rejecting, setRejecting] = useState<Device | null>(null)
  const all = useQuery({ ...devicesQuery({ status: 'all' }), enabled: devices.some((device) => device.replaces_device_id) })

  const decide = useMutation({
    mutationFn: async ({ device, action }: { device: Device; action: 'approve' | 'reject' }) => {
      if (action === 'approve') await devicesApi.approve(device.id)
      else await devicesApi.reject(device.id)
      return { device, action }
    },
    onSuccess: ({ device, action }) => {
      setRejecting(null)
      toast.success(action === 'approve' ? `Approved ${device.hostname}` : `Rejected ${device.hostname}`)
      void queryClient.invalidateQueries({ queryKey: keys.devices })
      void queryClient.invalidateQueries({ queryKey: ['fleet'] })
    },
  })

  const approveAll = useMutation({
    mutationFn: async () => {
      const results = await Promise.allSettled(devices.map((device) => devicesApi.approve(device.id)))
      return results.filter((result) => result.status === 'fulfilled').length
    },
    meta: { silent: true },
    onSuccess: (count) => {
      toast.success(`Approved ${count} ${count === 1 ? 'device' : 'devices'}`)
      void queryClient.invalidateQueries({ queryKey: keys.devices })
      void queryClient.invalidateQueries({ queryKey: ['fleet'] })
    },
  })

  if (loading) {
    return (
      <div className="grid gap-2">
        {Array.from({ length: 3 }, (_, index) => (
          <Skeleton key={index} className="h-16 rounded-xl" />
        ))}
      </div>
    )
  }

  if (devices.length === 0) {
    return (
      <EmptyState
        illustration="security"
        title="Nothing waiting for approval"
        description="Devices that enroll with a key requiring approval show up here. They can't receive commands until approved."
      />
    )
  }

  return (
    <div className="grid gap-3 [&>*]:min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-dense text-muted-foreground">
          Check the hostname and source address before approving. Unexpected devices may mean a deploy key has leaked.
        </p>
        {canApprove && devices.length > 1 && (
          <Button size="sm" variant="outline" disabled={approveAll.isPending} onClick={() => approveAll.mutate()}>
            {approveAll.isPending ? <Spinner data-icon="inline-start" /> : <Check data-icon="inline-start" />}
            Approve all {devices.length}
          </Button>
        )}
      </div>
      <ul className="grid gap-2">
        {devices.map((device) => {
          const replaced = device.replaces_device_id ? all.data?.find((item) => item.id === device.replaces_device_id) : undefined
          const busy = decide.isPending && decide.variables?.device.id === device.id
          return (
            <li key={device.id} className="flex flex-wrap items-center gap-3 rounded-xl bg-card px-4 py-3 shadow-card">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-surface-2 ring-1 ring-border">
                <OsIcon family={device.os_family} className="size-4" />
              </span>
              <div className="min-w-0 flex-1 basis-56">
                <div className="flex flex-wrap items-center gap-2">
                  <Link to="/devices/$deviceId" params={{ deviceId: device.id }} className="truncate font-medium hover:underline">
                    {deviceName(device)}
                  </Link>
                  {device.replaces_device_id && (
                    <Tooltip>
                      <TooltipTrigger render={<span className="inline-flex" />}>
                        <Badge variant="info">
                          <RotateCw />
                          Re-enrollment
                        </Badge>
                      </TooltipTrigger>
                      <TooltipContent>
                        Same machine as {replaced ? deviceName(replaced) : 'an existing device'}; approving retires the old enrollment.
                      </TooltipContent>
                    </Tooltip>
                  )}
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-micro text-muted-foreground">
                  <span>
                    {device.client_name} / {device.site_name}
                  </span>
                  <span className="text-subtle-foreground">·</span>
                  <span>{device.os_name}</span>
                  {device.last_ip && (
                    <>
                      <span className="text-subtle-foreground">·</span>
                      <span className="font-mono">{device.last_ip}</span>
                    </>
                  )}
                  {device.last_user && (
                    <>
                      <span className="text-subtle-foreground">·</span>
                      <span>{device.last_user}</span>
                    </>
                  )}
                  <span className="text-subtle-foreground">·</span>
                  <span>
                    requested <RelativeTime value={device.enrolled_at} />
                  </span>
                </div>
              </div>
              {canApprove ? (
                <div className="flex shrink-0 items-center gap-2">
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => setRejecting(device)}>
                    <X data-icon="inline-start" />
                    Reject
                  </Button>
                  <Button size="sm" disabled={busy} onClick={() => decide.mutate({ device, action: 'approve' })}>
                    {busy && decide.variables?.action === 'approve' ? <Spinner data-icon="inline-start" /> : <Check data-icon="inline-start" />}
                    Approve
                  </Button>
                </div>
              ) : (
                <Badge variant="outline">Needs a technician with approval rights</Badge>
              )}
            </li>
          )
        })}
      </ul>
      <ConfirmDialog
        open={Boolean(rejecting)}
        onOpenChange={(open) => !open && setRejecting(null)}
        title={`Reject ${rejecting?.hostname}?`}
        description="The enrollment request is discarded and the agent is told to stop. It can try again with a valid deploy key."
        confirmLabel="Reject enrollment"
        pending={decide.isPending}
        onConfirm={() => rejecting && decide.mutate({ device: rejecting, action: 'reject' })}
      />
    </div>
  )
}

// ------------------------------------------------------------------ page

function SummaryTile({ label, value, icon, tone }: { label: string; value: ReactNode; icon: ReactNode; tone?: string }) {
  return (
    <div className="flex items-center gap-3 rounded-xl bg-card px-4 py-3 shadow-card">
      <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-3 text-muted-foreground ring-1 ring-border [&_svg]:size-4', tone)}>{icon}</span>
      <div className="min-w-0">
        <div className="font-display tabular text-lg leading-tight font-semibold">{value}</div>
        <div className="truncate text-micro text-muted-foreground">{label}</div>
      </div>
    </div>
  )
}

export function DeployPage({ search }: { search: DeploySearch }) {
  useTitle('Deploy agents')
  const navigate = useNavigate()
  const me = useMe()
  const { clientId, siteId } = useScope()
  const canDeploy = hasPermission(me, PERMISSIONS.agentsDeploy)
  const canApprove = hasPermission(me, PERMISSIONS.agentsApprove)
  const enrollment = useQuery({ ...enrollmentQuery({ client_id: clientId, site_id: siteId }), enabled: canDeploy })
  const pendingQuery = useQuery(devicesQuery({ status: 'pending', client_id: clientId, site_id: siteId }))
  const tokens = useMemo(() => enrollment.data?.items ?? [], [enrollment.data])
  const activeTokens = useMemo(() => tokens.filter((token) => token.status === 'active'), [tokens])
  const [pickedKey, setPickedKey] = useState<string | null>(null)
  const selectedKey = pickedKey && activeTokens.some((token) => token.id === pickedKey) ? pickedKey : (activeTokens[0]?.id ?? null)
  const pending = pendingQuery.data ?? []
  const section = search.section ?? (canDeploy ? 'keys' : 'approvals')

  const setSearch = (patch: Partial<DeploySearch>) =>
    void navigate({ from: '/devices/deploy', to: '/devices/deploy', search: (prev) => ({ ...prev, ...patch }), replace: true })
  const openCreate = () => setSearch({ new: true })
  const enrollments = tokens.reduce((sum, token) => sum + token.uses, 0)

  return (
    <div className="flex h-full">
      <DevicesContextPanel />
      <div className="min-w-0 flex-1 overflow-y-auto">
        <PageContainer className="grid gap-5 [&>*]:min-w-0">
          <PageHeader
            icon={<Rocket />}
            title="Deploy agents"
            description="Create scoped deploy keys, download installers for Windows, macOS and Linux, or roll out silently with Group Policy."
            actions={
              <Can permission={PERMISSIONS.agentsDeploy}>
                <Button onClick={openCreate}>
                  <Plus data-icon="inline-start" />
                  New deploy key
                </Button>
              </Can>
            }
          />

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <SummaryTile label="Active deploy keys" value={canDeploy ? formatNumber(activeTokens.length) : '—'} icon={<KeyRound />} tone="text-primary bg-primary/10 ring-primary/20" />
            <SummaryTile label="Enrollments with these keys" value={canDeploy ? formatNumber(enrollments) : '—'} icon={<ArrowUpRight />} />
            <SummaryTile
              label="Awaiting approval"
              value={formatNumber(pending.length)}
              icon={<Inbox />}
              tone={pending.length > 0 ? 'text-info bg-info/10 ring-info/25' : undefined}
            />
            <SummaryTile label="Agent builds available" value={canDeploy ? formatNumber(enrollment.data?.artifacts.length ?? 0) : '—'} icon={<Package />} />
          </div>

          {canDeploy && enrollment.error ? (
            <ErrorState error={enrollment.error} onRetry={() => void enrollment.refetch()} />
          ) : (
            <Tabs value={section} onValueChange={(value) => setSearch({ section: value as DeploySearch['section'] })} className="gap-4">
              <div className="-mx-4 overflow-x-auto border-b border-border px-4 [scrollbar-width:none] sm:mx-0 sm:px-0">
                <TabsList variant="line" className="-mb-px h-10 w-max gap-5">
                  {canDeploy && (
                    <>
                      <TabsTrigger value="keys" className="flex-none px-0">
                        Deploy keys <span className="tabular text-micro text-subtle-foreground">{tokens.length}</span>
                      </TabsTrigger>
                      <TabsTrigger value="install" className="flex-none px-0">
                        Installers
                      </TabsTrigger>
                      <TabsTrigger value="gpo" className="flex-none px-0">
                        Group Policy
                      </TabsTrigger>
                    </>
                  )}
                  <TabsTrigger value="approvals" className="flex-none px-0">
                    Approvals
                    {pending.length > 0 && <span className="tabular rounded-full bg-info/15 px-1.5 text-micro font-semibold text-info">{pending.length}</span>}
                  </TabsTrigger>
                </TabsList>
              </div>
              {canDeploy && (
                <>
                  <TabsContent value="keys">
                    <KeysTab tokens={tokens} loading={enrollment.isLoading} onCreate={openCreate} />
                  </TabsContent>
                  <TabsContent value="install">
                    <InstallTab
                      activeTokens={activeTokens}
                      selected={selectedKey}
                      onSelect={setPickedKey}
                      artifacts={enrollment.data?.artifacts ?? []}
                      onCreate={openCreate}
                    />
                  </TabsContent>
                  <TabsContent value="gpo">
                    <GpoTab activeTokens={activeTokens} selected={selectedKey} onSelect={setPickedKey} onCreate={openCreate} />
                  </TabsContent>
                </>
              )}
              <TabsContent value="approvals">
                <ApprovalsTab devices={pending} loading={pendingQuery.isLoading} canApprove={canApprove} />
              </TabsContent>
            </Tabs>
          )}
        </PageContainer>
      </div>

      <NewDeployKeyDialog
        open={Boolean(search.new) && canDeploy}
        onOpenChange={(open) => !open && setSearch({ new: undefined })}
        defaultClientId={clientId}
        defaultSiteId={siteId}
      />
    </div>
  )
}
