/* Settings → Code signing: is the imported agent bundle signed, per platform and file, and by whom. */
import { useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { BadgeCheck, CircleAlert, CircleHelp, FileBadge2, FolderOpen, PackageCheck, ShieldAlert, ShieldOff, Terminal } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { CopyButton } from '@/components/common/copy-button'
import { EmptyState } from '@/components/common/empty-state'
import { ErrorState, RelativeTime } from '@/components/common/misc'
import { OsIcon } from '@/components/common/os-icon'
import { PageContainer, PageHeader } from '@/components/common/page-header'
import { isApiError } from '@/lib/api/errors'
import { signingStatusQuery } from '@/lib/api/queries'
import type { SigningFile, SigningPlatform, SigningPlatformStatus } from '@/lib/api/types'
import { formatDate } from '@/lib/format'
import { PERMISSIONS, hasGlobalPermission, useMe } from '@/lib/permissions'
import { FORMAT_LABEL, METHOD_LABEL, certificateValidity, commonName, parsePlatform, tamperedFiles } from '@/lib/signing'
import { useTitle } from '@/lib/use-title'
import { cn } from '@/lib/utils'
import { SettingsCard } from './platform-ui'

const PLATFORM_BADGE: Record<SigningPlatformStatus, { variant: 'success' | 'warning' | 'critical' | 'secondary'; label: string }> = {
  signed: { variant: 'success', label: 'Signed' },
  partially_signed: { variant: 'warning', label: 'Partly signed' },
  unsigned: { variant: 'secondary', label: 'Unsigned' },
  invalid: { variant: 'critical', label: 'Signature mismatch' },
  unknown: { variant: 'secondary', label: 'Unknown' },
}

function Fact({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn('min-w-0', className)}>
      <dt className="text-micro text-subtle-foreground">{label}</dt>
      <dd className="min-w-0 text-dense">{children}</dd>
    </div>
  )
}

function FileIcon({ file }: { file: SigningFile }) {
  if (file.status === 'invalid' || file.digest_valid === false) return <ShieldAlert className="size-4 shrink-0 text-critical" />
  if (file.status === 'signed') return <BadgeCheck className="size-4 shrink-0 text-success" />
  if (file.status === 'unsigned') return <ShieldOff className="size-4 shrink-0 text-subtle-foreground" />
  return <CircleHelp className="size-4 shrink-0 text-subtle-foreground" />
}

function FileRow({ file, now }: { file: SigningFile; now: number }) {
  const signer = file.signer
  const validity = certificateValidity(signer, now)
  const tampered = file.digest_valid === false
  return (
    <li className={cn('grid min-w-0 gap-3 px-4 py-3', tampered && 'bg-critical/[0.05]')}>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <FileIcon file={file} />
        <span className="min-w-0 truncate font-mono text-[12px]" title={file.file}>
          {file.file}
        </span>
        <Badge variant="outline">{FORMAT_LABEL[file.format]}</Badge>
        {file.method && <Badge variant="secondary">{METHOD_LABEL[file.method]}</Badge>}
        <span className={cn('ml-auto text-micro font-medium', file.status === 'signed' ? 'text-success' : file.status === 'invalid' ? 'text-critical' : 'text-muted-foreground')}>
          {file.status === 'signed' ? 'Signed' : file.status === 'invalid' ? 'Invalid signature' : file.status === 'unsigned' ? 'Not signed' : 'Could not be read'}
        </span>
      </div>

      {tampered && (
        <p role="alert" className="flex items-start gap-2 rounded-lg bg-critical/10 px-3 py-2 text-dense font-medium text-critical ring-1 ring-critical/30">
          <ShieldAlert className="mt-0.5 size-4 shrink-0" />
          <span>
            Tampered: the Authenticode digest does not match the file, so it was modified after it was signed. Do not deploy this build; re-import a clean release.
          </span>
        </p>
      )}

      {signer && (
        <dl className="grid min-w-0 gap-x-4 gap-y-2 sm:grid-cols-2">
          <Fact label="Signed by">
            <span className="block truncate font-medium" title={signer.subject}>
              {commonName(signer.subject)}
            </span>
          </Fact>
          <Fact label="Issuer">
            <span className="block truncate text-muted-foreground" title={signer.issuer ?? undefined}>
              {commonName(signer.issuer) ?? '—'}
            </span>
          </Fact>
          {signer.thumbprint_sha1 && (
            <Fact label="Thumbprint (SHA-1)">
              <span className="flex min-w-0 items-center gap-1">
                <span className="truncate font-mono text-[11px] text-muted-foreground">{signer.thumbprint_sha1}</span>
                <CopyButton value={signer.thumbprint_sha1} label="Copy thumbprint" />
              </span>
            </Fact>
          )}
          {signer.serial && (
            <Fact label="Serial">
              <span className="block truncate font-mono text-[11px] text-muted-foreground">{signer.serial}</span>
            </Fact>
          )}
          {(signer.not_before || signer.not_after) && (
            <Fact label="Valid">
              <span className={cn('tabular', validity === 'expired' || validity === 'not_yet_valid' ? 'font-medium text-critical' : validity === 'expiring' ? 'font-medium text-warning' : 'text-muted-foreground')}>
                {signer.not_before ? formatDate(signer.not_before) : '…'} → {signer.not_after ? formatDate(signer.not_after) : '…'}
                {validity === 'expired' && ' · expired'}
                {validity === 'expiring' && ' · expires soon'}
                {validity === 'not_yet_valid' && ' · not valid yet'}
              </span>
            </Fact>
          )}
          {file.timestamped !== null && (
            <Fact label="Timestamp">
              <span className={file.timestamped ? 'text-muted-foreground' : 'text-warning'}>{file.timestamped ? 'Timestamped (stays valid after the certificate expires)' : 'Not timestamped'}</span>
            </Fact>
          )}
          {file.format === 'pe' && file.digest_valid !== null && (
            <Fact label="Digest">
              <span className={file.digest_valid ? 'text-success' : 'font-semibold text-critical'}>{file.digest_valid ? 'Matches the file' : 'Does not match (tampered)'}</span>
            </Fact>
          )}
          {file.format === 'msi' && (
            <Fact label="Digest">
              <span className="text-subtle-foreground">Not recomputed for MSI packages</span>
            </Fact>
          )}
        </dl>
      )}

      {file.detail && !tampered && (
        <p className={cn('flex items-start gap-1.5 text-dense', file.status === 'invalid' ? 'text-critical' : 'text-muted-foreground')}>
          <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
          {file.detail}
        </p>
      )}
    </li>
  )
}

function PlatformCard({ platform, now }: { platform: SigningPlatform; now: number }) {
  const parsed = parsePlatform(platform.platform)
  const badge = PLATFORM_BADGE[platform.status] ?? PLATFORM_BADGE.unknown
  return (
    <SettingsCard
      icon={parsed.family ? <OsIcon family={parsed.family} className="size-4" /> : <FileBadge2 />}
      title={
        <span className="flex flex-wrap items-center gap-1.5">
          {parsed.label}
          {parsed.arch && <span className="inline-flex h-5 items-center rounded-[5px] bg-surface-3 px-1.5 font-mono text-[10.5px] font-medium text-secondary-foreground ring-1 ring-border">{parsed.arch}</span>}
        </span>
      }
      description={`${platform.files.length} ${platform.files.length === 1 ? 'file' : 'files'}`}
      actions={<Badge variant={badge.variant}>{badge.label}</Badge>}
      className={cn(platform.status === 'invalid' && 'ring-1 ring-critical/40')}
    >
      {platform.files.length === 0 ? (
        <p className="px-4 py-3 text-dense text-muted-foreground">No artifacts for this platform.</p>
      ) : (
        <ul className="divide-y divide-border">
          {platform.files.map((file) => (
            <FileRow key={file.file} file={file} now={now} />
          ))}
        </ul>
      )}
    </SettingsCard>
  )
}

function HowToSign() {
  return (
    <SettingsCard icon={<Terminal />} title="Signing your builds" description="Configured in signing.toml or RUSTRMM_SIGN_* variables in CI. Unconfigured builds skip signing with a warning; --require-signing makes it an error.">
      <div className="grid gap-3 px-4 py-3 text-dense text-muted-foreground lg:grid-cols-2">
        <pre className="overflow-x-auto rounded-lg bg-surface-3 px-3 py-2 font-mono text-[11.5px] leading-relaxed text-foreground ring-1 ring-border">{`cargo xtask sign --provider pfx      # or pkcs11, azure\ncargo xtask sign --provider apple-devid\ncargo xtask dist                      # signs, then packs the MSI`}</pre>
        <ul className="grid content-start gap-1">
          <li>· Windows: the exe is signed before it is packed into the MSI, then the MSI; both get RFC 3161 timestamps.</li>
          <li>· macOS: codesign with a Developer ID plus notarytool. Notarization can’t be checked offline.</li>
          <li>· Linux: optional minisign signatures (.minisig next to each binary).</li>
          <li>· docs/signing.md walks through each provider step by step.</li>
        </ul>
      </div>
    </SettingsCard>
  )
}

export function SigningPage() {
  useTitle('Code signing')
  const me = useMe()
  const canView = hasGlobalPermission(me, PERMISSIONS.settingsManage)
  const { data, isLoading, error, refetch } = useQuery({ ...signingStatusQuery, enabled: canView })
  const notAvailable = isApiError(error) && (error.status === 404 || error.status === 405)
  const forbidden = !canView || (isApiError(error) && error.status === 403)
  const [now] = useState(() => Date.now())
  const tampered = data ? tamperedFiles(data) : []
  const files = data?.platforms.flatMap((platform) => platform.files) ?? []

  return (
    <PageContainer className="grid max-w-5xl grid-cols-1 gap-5">
      <PageHeader title="Code signing" description="Whether the agent bundle this server distributes is signed, and by whom. Signed installers avoid SmartScreen and Gatekeeper warnings and prove they came from you." />
      {forbidden ? (
        <EmptyState illustration="security" title="Code signing needs “Manage settings”" description="The signing status inspects the agent bundle on the server, so it needs the Manage settings permission held installation-wide." />
      ) : notAvailable ? (
        <EmptyState illustration="security" title="Signing status isn’t available on this server yet" description="Update the server to read Authenticode, Apple and minisign signatures from the agent bundle." />
      ) : error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : isLoading || !data ? (
        <div className="grid gap-3">
          {Array.from({ length: 3 }, (_, index) => (
            <Skeleton key={index} className="h-36 rounded-xl" />
          ))}
        </div>
      ) : data.source === 'none' ? (
        <EmptyState
          illustration="security"
          title="No agent bundle imported yet"
          description="Build a release with cargo xtask dist and point the server at it (RUSTRMM_AGENT_DIST); it imports and signs the bundle at startup. Its signatures show up here."
          actions={
            <Button size="sm" variant="outline" render={<Link to="/devices/deploy" />} nativeButton={false}>
              Deploy agents
            </Button>
          }
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3 rounded-xl bg-card px-4 py-3 shadow-card">
            {data.source === 'release' ? <PackageCheck className="size-5 shrink-0 text-subtle-foreground" /> : <FolderOpen className="size-5 shrink-0 text-subtle-foreground" />}
            <p className="min-w-0 flex-1 text-dense">
              {data.source === 'release' ? (
                <>
                  Release <span className="font-mono font-medium">{data.version ?? '—'}</span>
                  {data.imported_at && (
                    <>
                      , imported <RelativeTime value={data.imported_at} />
                    </>
                  )}
                </>
              ) : (
                <>No release imported yet — showing the agent distribution directory.</>
              )}
            </p>
            <span className="tabular text-micro text-muted-foreground">
              {files.filter((file) => file.status === 'signed').length} of {files.length} files signed
            </span>
          </div>
          {files.length > 0 && files.every((file) => file.status === 'unsigned') && (
            <div className="flex items-start gap-2.5 rounded-xl bg-surface-2 px-4 py-3 text-dense ring-1 ring-border">
              <ShieldOff className="mt-0.5 size-4 shrink-0 text-subtle-foreground" />
              <span className="min-w-0">
                <span className="block font-medium">This bundle isn’t signed yet</span>
                <span className="text-muted-foreground">
                  That’s the default until a signing provider is configured. Agents install and work, but Windows SmartScreen and macOS Gatekeeper may warn users. Sign builds with{' '}
                  <code className="font-mono text-[12px] text-foreground">cargo xtask sign</code> (see <span className="font-mono text-[12px] text-foreground">docs/signing.md</span>) and import the new release.
                </span>
              </span>
            </div>
          )}
          {tampered.length > 0 && (
            <p role="alert" className="flex items-start gap-2.5 rounded-xl bg-critical/[0.08] px-4 py-3 text-dense ring-1 ring-critical/35">
              <ShieldAlert className="mt-0.5 size-5 shrink-0 text-critical" />
              <span>
                <span className="block font-semibold text-critical">
                  {tampered.length === 1 ? 'One file does not match its signature' : `${tampered.length} files do not match their signatures`}
                </span>
                <span className="text-muted-foreground">{tampered.map((entry) => `${entry.file.file} (${entry.platform})`).join(', ')} — modified after signing or corrupted.</span>
              </span>
            </p>
          )}
          {data.platforms.length === 0 ? (
            <EmptyState compact illustration="security" title="Nothing to check" description="The bundle has no platform files." />
          ) : (
            <div className="grid gap-3">
              {data.platforms.map((platform) => (
                <PlatformCard key={platform.platform} platform={platform} now={now} />
              ))}
            </div>
          )}
          <p className="text-micro text-subtle-foreground">Certificate chains are not validated here; this is an inventory of what was shipped. Windows and macOS make the trust decision on each endpoint.</p>
        </>
      )}
      <HowToSign />
    </PageContainer>
  )
}
