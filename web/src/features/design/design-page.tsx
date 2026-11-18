import { useMemo, useState, type ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import type { ColumnDef } from '@tanstack/react-table'
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from 'recharts'
import { ArrowLeft, Moon, Plus, Search, Sun, Trash } from 'lucide-react'
import { toast } from 'sonner'
import { LogoMark } from '@/components/brand/logo'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { TotpInput } from '@/components/auth/totp-input'
import { DataTable } from '@/components/common/data-table'
import { EmptyState } from '@/components/common/empty-state'
import { HealthRing } from '@/components/common/health-ring'
import { Illustration, type IllustrationName } from '@/components/common/illustrations'
import { EntityAvatar, Kbd, Mono, UserAvatar } from '@/components/common/misc'
import { PasswordMeter } from '@/components/common/password-meter'
import { SimpleSelect } from '@/components/common/simple-select'
import { StatusDot, type StatusTone } from '@/components/common/status-dot'
import { useDensity, useTheme } from '@/lib/theme'
import { useTitle } from '@/lib/use-title'

const SURFACES = ['surface-0', 'surface-1', 'surface-2', 'surface-3', 'surface-4']
const SEMANTIC = ['primary', 'live', 'success', 'warning', 'critical', 'info']
const CHARTS = ['chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5', 'chart-6']
const ILLUSTRATIONS: IllustrationName[] = [
  'devices', 'clients', 'alerts', 'automation', 'patching', 'software', 'tickets', 'network',
  'reports', 'audit', 'backups', 'users', 'search', 'launch', 'security',
]

const chartData = Array.from({ length: 14 }, (_, index) => ({
  day: `Nov ${index + 3}`,
  online: 180 + Math.round(Math.sin(index / 2) * 12 + index * 1.5),
  alerts: 6 + Math.round(Math.cos(index / 1.6) * 4 + 4),
}))

const chartConfig = {
  online: { label: 'Online devices', color: 'var(--chart-2)' },
  alerts: { label: 'Alerts', color: 'var(--chart-1)' },
} satisfies ChartConfig

interface SampleRow {
  id: string
  name: string
  os: string
  status: StatusTone
  cpu: number
}

const rows: SampleRow[] = [
  { id: '1', name: 'WS-0142', os: 'Windows 11 24H2', status: 'live', cpu: 23 },
  { id: '2', name: 'SRV-DC01', os: 'Windows Server 2025', status: 'live', cpu: 9 },
  { id: '3', name: 'MBP-07', os: 'macOS 15.1', status: 'offline', cpu: 0 },
  { id: '4', name: 'NAS-02', os: 'Debian 13', status: 'warning', cpu: 71 },
  { id: '5', name: 'POS-LANE3', os: 'Windows 10 LTSC', status: 'critical', cpu: 96 },
]

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid gap-3">
      <h2 className="eyebrow">{title}</h2>
      {children}
    </section>
  )
}

function Swatch({ token }: { token: string }) {
  return (
    <div className="grid gap-1.5">
      <div className="h-14 rounded-lg shadow-card" style={{ background: `var(--${token})` }} />
      <code className="font-mono text-[11px] text-muted-foreground">--{token}</code>
    </div>
  )
}

export function DesignPage() {
  useTitle('Design system')
  const { resolved, toggle } = useTheme()
  const { density, toggle: toggleDensity } = useDensity()
  const [dialog, setDialog] = useState(false)
  const [code, setCode] = useState('')
  const [select, setSelect] = useState<string | null>('daily')

  const columns = useMemo<ColumnDef<SampleRow>[]>(
    () => [
      {
        accessorKey: 'name',
        header: 'Device',
        cell: ({ row }) => (
          <span className="flex items-center gap-2">
            <StatusDot tone={row.original.status} pulse={row.original.status === 'live'} />
            <span className="font-medium">{row.original.name}</span>
          </span>
        ),
      },
      { accessorKey: 'os', header: 'Operating system' },
      {
        accessorKey: 'cpu',
        header: 'CPU',
        meta: { align: 'right' },
        cell: ({ getValue }) => <span className="tabular">{getValue<number>()}%</span>,
      },
    ],
    [],
  )

  return (
    <div className="min-h-dvh bg-background">
      <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-border bg-background/85 px-6 backdrop-blur">
        <Button variant="ghost" size="icon-sm" render={<Link to="/" />} nativeButton={false} aria-label="Back to app">
          <ArrowLeft />
        </Button>
        <LogoMark className="size-7" />
        <div>
          <div className="text-sm font-semibold">Design system</div>
          <div className="text-micro text-subtle-foreground">Tokens and components · internal QA</div>
        </div>
        <div className="ml-auto flex gap-2">
          <Button variant="outline" size="sm" onClick={toggleDensity}>
            Density: {density}
          </Button>
          <Button variant="outline" size="sm" onClick={toggle}>
            {resolved === 'dark' ? <Sun data-icon="inline-start" /> : <Moon data-icon="inline-start" />}
            {resolved === 'dark' ? 'Light' : 'Dark'}
          </Button>
        </div>
      </header>

      <main className="mx-auto grid max-w-6xl gap-10 px-6 py-8">
        <Section title="Surfaces">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            {SURFACES.map((token) => (
              <Swatch key={token} token={token} />
            ))}
          </div>
        </Section>

        <Section title="Brand & semantic">
          <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
            {SEMANTIC.map((token) => (
              <Swatch key={token} token={token} />
            ))}
          </div>
          <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
            {CHARTS.map((token) => (
              <Swatch key={token} token={token} />
            ))}
          </div>
        </Section>

        <Section title="Typography">
          <Card>
            <CardContent className="grid gap-3">
              <div className="font-display text-[28px] font-semibold tracking-tight">Display · Mona Sans 112%</div>
              <div className="font-display text-[22px] font-semibold">Page title · 22px</div>
              <div className="text-[15px] font-semibold">Section title · 15px</div>
              <div className="text-sm">Body · 14px — The quick brown fox jumps over the lazy dog.</div>
              <div className="font-condensed text-dense">Dense table text · 13px condensed 94%</div>
              <div className="eyebrow">Eyebrow label</div>
              <div className="tabular text-2xl font-semibold">1,284 · 96.4% · 00:42:17</div>
              <div className="font-mono text-[13px]">Monaspace Neon · rrmm1_d3pl0y-k3y 0x7f3a</div>
            </CardContent>
          </Card>
        </Section>

        <Section title="Buttons">
          <div className="flex flex-wrap items-center gap-2">
            <Button>
              <Plus data-icon="inline-start" />
              Primary
            </Button>
            <Button variant="outline">Outline</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="destructive">
              <Trash data-icon="inline-start" />
              Destructive
            </Button>
            <Button variant="destructive-soft">Destructive soft</Button>
            <Button variant="link">Link</Button>
            <Button disabled>Disabled</Button>
            <Button size="sm">Small</Button>
            <Button size="lg">Large</Button>
            <Button size="icon" variant="outline" aria-label="Search">
              <Search />
            </Button>
          </div>
        </Section>

        <Section title="Inputs">
          <Card>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="ds-input">Text input</Label>
                <Input id="ds-input" placeholder="Placeholder" />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="ds-invalid">Invalid input</Label>
                <Input id="ds-invalid" aria-invalid defaultValue="not-an-email" />
              </div>
              <div className="grid gap-1.5">
                <Label>Select</Label>
                <SimpleSelect
                  value={select}
                  onValueChange={setSelect}
                  options={[
                    { value: 'hourly', label: 'Every hour' },
                    { value: 'daily', label: 'Daily at 02:00' },
                    { value: 'weekly', label: 'Weekly' },
                  ]}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="ds-textarea">Textarea</Label>
                <Textarea id="ds-textarea" rows={2} placeholder="Notes…" />
              </div>
              <div className="grid gap-1.5">
                <Label>Password meter</Label>
                <PasswordMeter password="correct-horse-battery-staple" />
              </div>
              <div className="flex items-center gap-6">
                <label className="flex items-center gap-2 text-dense">
                  <Checkbox defaultChecked /> Checkbox
                </label>
                <label className="flex items-center gap-2 text-dense">
                  <Switch defaultChecked /> Switch
                </label>
              </div>
              <div className="grid gap-1.5 sm:col-span-2">
                <Label>Authentication code</Label>
                <TotpInput value={code} onChange={setCode} autoFocus={false} className="justify-start" />
              </div>
            </CardContent>
          </Card>
        </Section>

        <Section title="Badges, status & identity">
          <div className="flex flex-wrap items-center gap-2">
            <Badge>Brand</Badge>
            <Badge variant="secondary">Secondary</Badge>
            <Badge variant="outline">Outline</Badge>
            <Badge variant="live">Online</Badge>
            <Badge variant="success">Succeeded</Badge>
            <Badge variant="warning">Pending</Badge>
            <Badge variant="critical">Critical</Badge>
            <Badge variant="info">Info</Badge>
            <span className="mx-2 h-5 w-px bg-border-strong" />
            {(['live', 'offline', 'success', 'warning', 'critical', 'info'] as StatusTone[]).map((tone) => (
              <StatusDot key={tone} tone={tone} pulse={tone === 'live'} />
            ))}
            <span className="mx-2 h-5 w-px bg-border-strong" />
            <EntityAvatar name="Northwind Dental" accent="#3FB8A9" />
            <EntityAvatar name="Summit Freight" accent="#E07444" size="sm" />
            <UserAvatar name="Avery Chen" />
            <Mono>10.20.0.14</Mono>
            <Kbd>Ctrl</Kbd>
            <Kbd>K</Kbd>
            <HealthRing score={94} />
            <HealthRing score={72} />
            <HealthRing score={41} />
            <HealthRing score={null} />
          </div>
          <Progress value={64} className="max-w-sm" />
        </Section>

        <Section title="Cards & chart">
          <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
            <Card>
              <CardHeader>
                <CardTitle>Fleet availability</CardTitle>
                <CardDescription>Online devices and alerts over 14 days</CardDescription>
              </CardHeader>
              <CardContent>
                <ChartContainer config={chartConfig} className="aspect-auto h-56 w-full">
                  <AreaChart data={chartData} margin={{ left: 0, right: 8, top: 8 }}>
                    <defs>
                      <linearGradient id="fill-online" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="var(--color-online)" stopOpacity={0.35} />
                        <stop offset="100%" stopColor="var(--color-online)" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid vertical={false} strokeDasharray="3 4" />
                    <XAxis dataKey="day" tickLine={false} axisLine={false} tickMargin={8} />
                    <YAxis tickLine={false} axisLine={false} width={32} />
                    <ChartTooltip content={<ChartTooltipContent />} />
                    <Area dataKey="online" type="monotone" stroke="var(--color-online)" fill="url(#fill-online)" strokeWidth={2} />
                    <Area dataKey="alerts" type="monotone" stroke="var(--color-alerts)" fill="transparent" strokeWidth={2} />
                  </AreaChart>
                </ChartContainer>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Overlays</CardTitle>
                <CardDescription>Dialogs and toasts</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-2">
                <Button variant="outline" onClick={() => setDialog(true)}>
                  Open dialog
                </Button>
                <Button variant="outline" onClick={() => toast.success('Backup completed', { description: '44.2 MB · 2 copies' })}>
                  Success toast
                </Button>
                <Button variant="outline" onClick={() => toast.error('S3 upload timed out after 30s')}>
                  Error toast
                </Button>
                <Button variant="outline" onClick={() => toast.info('Agent v0.2.0 is available')}>
                  Info toast
                </Button>
              </CardContent>
            </Card>
          </div>
        </Section>

        <Section title="Data table">
          <DataTable data={rows} columns={columns} getRowId={(row) => row.id} onRowClick={() => toast('Row clicked')} />
        </Section>

        <Section title="Skeletons & empty state">
          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardContent className="grid gap-3">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-3/4" />
              </CardContent>
            </Card>
            <EmptyState compact illustration="launch" title="Nothing here yet" description="Empty states guide the next step." actions={<Button size="sm">Primary action</Button>} />
          </div>
        </Section>

        <Section title="Illustrations">
          <div className="grid grid-cols-3 gap-3 sm:grid-cols-5">
            {ILLUSTRATIONS.map((name) => (
              <div key={name} className="grid justify-items-center gap-1 rounded-xl bg-card p-3 shadow-card">
                <Illustration name={name} className="h-20" />
                <code className="font-mono text-[11px] text-muted-foreground">{name}</code>
              </div>
            ))}
          </div>
        </Section>
      </main>

      <Dialog open={dialog} onOpenChange={setDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Dialog title</DialogTitle>
            <DialogDescription>Dialogs use the popover surface, hairline ring and a deep shadow.</DialogDescription>
          </DialogHeader>
          <Input placeholder="Focus me" />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialog(false)}>
              Cancel
            </Button>
            <Button onClick={() => setDialog(false)}>Confirm</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
