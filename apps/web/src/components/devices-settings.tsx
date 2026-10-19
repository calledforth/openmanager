import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import {
  CheckIcon,
  CloudIcon,
  CopyIcon,
  DesktopIcon,
  DevicesIcon,
  LinkSimpleIcon,
  QrCodeIcon,
  XIcon,
} from '@phosphor-icons/react'
import {
  isEnvironmentClientError,
  type AuthorizedClient,
  type AuthorizedClientList,
  type EnvironmentClient,
  type PairingLink,
} from '@openmanager/environment-client'
import { CLIENT_LABEL_MAX_LENGTH, type AccessCapability } from '@openmanager/protocol'
import { Button } from '@openmanager/app-core/components/fluid/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@openmanager/app-core/components/fluid/ui/dialog'
import {
  phosphorIcon,
  type IconComponent,
} from '@openmanager/app-core/components/fluid/lib/icon-context'
import { Tooltip } from '@openmanager/app-core/components/ui/Tooltip'
import { formatRelativeTime, useNow } from '@openmanager/app-core/lib/relative-time'
import {
  useConnectionState,
  useEnvironmentClientOptional,
} from '@openmanager/app-core/providers/environment-client'
import type { EnvironmentRoute } from '../lib/environment-store'
import {
  forgetPairingLinks,
  madePairingLinks,
  type MadePairingLink,
} from '../lib/pairing-link-store'
import { cn } from '../lib/utils'
import { formatRemaining, PairDeviceDialog, type ShownPairingLink } from './pair-device-dialog'

const KIND_ICONS: Record<AuthorizedClient['kind'], IconComponent> = {
  owner: phosphorIcon(DesktopIcon),
  paired: phosphorIcon(DevicesIcon),
  cloud: phosphorIcon(CloudIcon),
}

const CAPABILITY_LABELS: Record<AccessCapability, string> = {
  read: 'View',
  operate: 'Edit',
  agent: 'Run agents',
  terminal: 'Terminals',
  admin: 'Manage access',
}

const ALL_CAPABILITIES = Object.keys(CAPABILITY_LABELS) as AccessCapability[]

/** What a device may do, in words: "Full access", or the capabilities it holds. */
export function describeAccess(capabilities: readonly AccessCapability[]): string {
  if (ALL_CAPABILITIES.every((capability) => capabilities.includes(capability))) {
    return 'Full access'
  }
  return ALL_CAPABILITIES.filter((capability) => capabilities.includes(capability))
    .map((capability) => CAPABILITY_LABELS[capability])
    .join(', ')
}

/** "Online now", "Last seen 3h ago", or "Never connected". */
export function describePresence(client: AuthorizedClient, now: number): string {
  if (client.connected) return 'Online now'
  if (!client.lastSeenAt) return 'Never connected'
  const age = formatRelativeTime(client.lastSeenAt, now)
  if (age === 'now') return 'Last seen just now'
  return /^\d/.test(age) ? `Last seen ${age} ago` : `Last seen ${age}`
}

/** What the list leaves out, and whether revoking the others reaches it. */
export function omittedNote(omitted: number, includesThisDevice: boolean): string {
  const shown = `${omitted === 1 ? '1 more device' : `${omitted} more devices`}, the least recently seen, ${omitted === 1 ? 'is' : 'are'} not shown`
  if (!includesThisDevice) {
    return `${shown}. Revoking all other devices reaches ${omitted === 1 ? 'it' : 'them'} too.`
  }
  if (omitted === 1) return `${shown}: this one.`
  return `${shown}, this one among them. Revoking all other devices reaches the rest.`
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

// The same quiet fill as the other settings fields.
const fieldClass =
  'h-7 min-w-0 flex-1 rounded-md bg-hover px-2 text-[13px] text-foreground outline-none transition-colors duration-100 placeholder:text-faint focus:bg-active disabled:opacity-60'

/** What a pairing link needs to know about the environment it opens. */
export type PairingTarget = {
  environmentId: string
  routes: readonly EnvironmentRoute[]
  inUseEndpoint: string | null
  /** Where this web app is served: the page a link opens. */
  appUrl: string
}

type Confirm =
  | { kind: 'revoke'; client: AuthorizedClient }
  | { kind: 'revoke_others'; count: number }
  | { kind: 'rotate' }

/**
 * Every device that can reach the connected environment: its name, when it
 * was last seen, what it may do, and revoking it. Reading the list needs the
 * `admin` capability, which the owner holds; a device without it is told so.
 */
export function DevicesSettingControl({
  section,
  onCredentialRotated,
  pairing,
}: {
  /** The settings section around the control, given its description. */
  section: (body: ReactNode) => ReactNode
  /**
   * Save the owner's new credential; the connection redials with it. Without
   * one there is nowhere to keep a new credential, so rotating is not offered.
   */
  onCredentialRotated?: (credential: string) => void
  /** Where a pairing link sends a new device. Without it, pairing is not offered. */
  pairing?: PairingTarget
}) {
  const client = useEnvironmentClientOptional()
  if (!client) {
    return section(<Note>Connect to an environment to see the devices that can reach it.</Note>)
  }
  return (
    <ConnectedDevices
      client={client}
      section={section}
      onCredentialRotated={onCredentialRotated}
      pairing={pairing}
    />
  )
}

function ConnectedDevices({
  client,
  section,
  onCredentialRotated,
  pairing,
}: {
  client: EnvironmentClient
  section: (body: ReactNode) => ReactNode
  onCredentialRotated?: (credential: string) => void
  pairing?: PairingTarget
}) {
  const connection = useConnectionState()
  return section(
    <DeviceList
      client={client}
      connected={connection.phase === 'connected'}
      onCredentialRotated={onCredentialRotated}
      pairing={pairing}
    />,
  )
}

function Note({ children, role }: { children: ReactNode; role?: 'alert' }) {
  return (
    <p
      role={role}
      className={cn('mt-2 text-[13px]', role ? 'text-destructive' : 'text-muted-foreground')}
    >
      {children}
    </p>
  )
}

function DeviceList({
  client,
  connected,
  onCredentialRotated,
  pairing,
}: {
  client: EnvironmentClient
  connected: boolean
  onCredentialRotated?: (credential: string) => void
  pairing?: PairingTarget
}) {
  const [list, setList] = useState<AuthorizedClientList | null>(null)
  const [loadError, setLoadError] = useState<{ denied: boolean; message: string } | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // The confirm stays set while its dialog animates out, so its copy does too.
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [pairingOpen, setPairingOpen] = useState(false)
  // The link the pairing dialog reopens, or null to make a new one.
  const [reopen, setReopen] = useState<ShownPairingLink | null>(null)
  const links = usePairingLinks(
    client,
    connected,
    // Listing links needs `admin`, as listing devices does: only ask once that worked.
    pairing !== undefined && list !== null,
    pairing?.environmentId,
  )
  const openPairing = (link: ShownPairingLink | null) => {
    setActionError(null)
    setReopen(link)
    setPairingOpen(true)
  }
  const ask = (next: Confirm) => {
    setActionError(null)
    setConfirm(next)
    setConfirmOpen(true)
  }
  const now = useNow()
  const generation = useRef(0)

  const load = useCallback(() => {
    const current = ++generation.current
    setLoadError(null)
    client.commands.listAuthorizedClients().then(
      (next) => {
        if (current === generation.current) setList(next)
      },
      (error: unknown) => {
        if (current !== generation.current) return
        setLoadError({
          denied: isEnvironmentClientError(error) && error.code === 'capability_missing',
          message: message(error),
        })
      },
    )
  }, [client])

  // Listing is also what asks the environment for changes, and a new
  // connection has to ask again, so every (re)connect lists afresh.
  useEffect(() => {
    if (connected) load()
  }, [connected, load])

  useEffect(() => {
    // Another environment's devices, or its refusal, must not show while
    // this one's load.
    setList(null)
    setLoadError(null)
    setActionError(null)
    setRenaming(null)
    setConfirmOpen(false)
    setPairingOpen(false)
    setReopen(null)
    return client.onAuthorizedClientsChanged?.((next) => {
      generation.current += 1
      setList(next)
    })
  }, [client])

  if (loadError?.denied) {
    return (
      <Note>
        This device cannot manage access. Open this page on a device that can, such as the
        environment&apos;s own machine.
      </Note>
    )
  }
  if (loadError) {
    return (
      <div className="mt-2 flex items-center gap-2">
        <Note role="alert">{loadError.message}</Note>
        <Button type="button" variant="tertiary" size="compact" onClick={load}>
          Retry
        </Button>
      </div>
    )
  }
  if (!list) {
    return <Note>{connected ? 'Loading devices…' : 'Reconnecting to the environment…'}</Note>
  }

  const current = list.clients.find((item) => item.clientId === list.currentClientId)
  const others = list.clients.filter(
    (item) => item.clientId !== list.currentClientId && item.kind !== 'owner',
  )
  // The owner always leads the list, so only this device can be among the
  // omitted ones, and revoking the others never takes it.
  const revocableOthers = others.length + list.omitted - (current ? 0 : 1)

  const run = async (work: () => Promise<void>) => {
    setBusy(true)
    setActionError(null)
    try {
      await work()
      return true
    } catch (error) {
      setActionError(message(error))
      return false
    } finally {
      setBusy(false)
    }
  }

  const rename = (clientId: string, label: string) =>
    run(async () => {
      const renamed = await client.commands.renameAuthorizedClient(clientId, label)
      setList((value) =>
        value
          ? {
              ...value,
              clients: value.clients.map((item) => (item.clientId === clientId ? renamed : item)),
            }
          : value,
      )
      setRenaming(null)
    })

  const confirmAction = async () => {
    if (!confirm) return
    const done = await run(async () => {
      if (confirm.kind === 'revoke') {
        await client.commands.revokeAuthorizedClient(confirm.client.clientId)
        setList((value) =>
          value
            ? {
                ...value,
                clients: value.clients.filter((item) => item.clientId !== confirm.client.clientId),
              }
            : value,
        )
      } else if (confirm.kind === 'revoke_others') {
        const revoked = await client.commands.revokeOtherAuthorizedClients()
        setList((value) =>
          value
            ? {
                ...value,
                clients: value.clients.filter((item) => !revoked.includes(item.clientId)),
              }
            : value,
        )
      } else if (onCredentialRotated) {
        const rotated = await client.commands.rotateOwnerCredential()
        onCredentialRotated(rotated.credential)
      }
    })
    if (done) setConfirmOpen(false)
  }

  return (
    <>
      <ul className="mt-3 flex flex-col gap-1" aria-label="Devices">
        {list.clients.map((item) => (
          <DeviceRow
            key={item.clientId}
            device={item}
            now={now}
            isCurrent={item.clientId === list.currentClientId}
            canRotate={
              item.kind === 'owner' &&
              current?.kind === 'owner' &&
              onCredentialRotated !== undefined
            }
            // Only the owner names the owner.
            canRename={item.kind !== 'owner' || current?.kind === 'owner'}
            renaming={renaming === item.clientId}
            busy={busy}
            onStartRename={() => {
              setActionError(null)
              setRenaming(item.clientId)
            }}
            onCancelRename={() => setRenaming(null)}
            onRename={(label) => void rename(item.clientId, label)}
            onRevoke={() => ask({ kind: 'revoke', client: item })}
            onRotate={() => ask({ kind: 'rotate' })}
          />
        ))}
      </ul>
      {list.omitted > 0 ? <Note>{omittedNote(list.omitted, current === undefined)}</Note> : null}
      {actionError && !confirmOpen ? <Note role="alert">{actionError}</Note> : null}
      {pairing ? (
        <PairingLinks
          client={client}
          environmentId={pairing.environmentId}
          state={links}
          currentClientId={list.currentClientId}
          deviceLabel={(clientId) => list.clients.find((item) => item.clientId === clientId)?.label}
          // The dialog that shows a link needs this device's own row.
          onShow={current ? openPairing : undefined}
        />
      ) : null}
      {(pairing && current) || revocableOthers > 0 ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {pairing && current ? (
            <Button
              type="button"
              variant="primary"
              disabled={busy}
              onClick={() => openPairing(null)}
            >
              Pair a device
            </Button>
          ) : null}
          {revocableOthers > 0 ? (
            <Button
              type="button"
              variant="tertiary"
              disabled={busy}
              onClick={() => ask({ kind: 'revoke_others', count: revocableOthers })}
            >
              Revoke all other devices
            </Button>
          ) : null}
        </div>
      ) : null}
      {pairing && current ? (
        <PairDeviceDialog
          client={client}
          open={pairingOpen}
          onOpenChange={(open) => {
            setPairingOpen(open)
            // Whatever the dialog did, the list says where its links stand now.
            if (!open) links.refresh()
          }}
          reopen={reopen}
          onLinksChanged={links.refresh}
          grant={current.capabilities}
          environmentId={pairing.environmentId}
          routes={pairing.routes}
          inUseEndpoint={pairing.inUseEndpoint}
          appUrl={pairing.appUrl}
          deviceLabel={(clientId) => list.clients.find((item) => item.clientId === clientId)?.label}
        />
      ) : null}
      <ConfirmDialog
        confirm={confirm}
        open={confirmOpen}
        busy={busy}
        error={confirmOpen ? actionError : null}
        onCancel={() => {
          if (busy) return
          setConfirmOpen(false)
          setActionError(null)
        }}
        onConfirm={() => void confirmAction()}
      />
    </>
  )
}

type PairingLinksState = {
  /** What the environment last reported, or null before it first answered. */
  links: readonly PairingLink[] | null
  error: string | null
  refresh: () => void
  /** The environment confirmed it withdrew this link. */
  withdrawn: (linkId: string) => void
}

/**
 * The environment's pairing links, read again whenever one may have changed:
 * on every (re)connect, when a device pairs (a link was probably used), and
 * when this tab makes or withdraws one. Nothing pushes link changes, so a
 * link made or withdrawn on another device shows on the next of those.
 */
function usePairingLinks(
  client: EnvironmentClient,
  connected: boolean,
  enabled: boolean,
  environmentId: string | undefined,
): PairingLinksState {
  const [links, setLinks] = useState<readonly PairingLink[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)

  useEffect(() => {
    // Another environment's links must not show while this one's load.
    generation.current += 1
    setLinks(null)
    setError(null)
  }, [client])

  const refresh = useCallback(() => {
    if (!enabled) return
    const current = ++generation.current
    client.commands.listPairingLinks().then(
      (next) => {
        if (current !== generation.current) return
        setLinks(next)
        setError(null)
        // A link that stopped working cannot be shown again.
        if (environmentId) {
          forgetPairingLinks(
            environmentId,
            next.filter((item) => item.status !== 'waiting').map((item) => item.linkId),
          )
        }
      },
      (caught: unknown) => {
        if (current === generation.current) setError(message(caught))
      },
    )
  }, [client, enabled, environmentId])

  useEffect(() => {
    if (connected) refresh()
  }, [connected, refresh])

  useEffect(() => client.onAuthorizedClientsChanged?.(() => refresh()), [client, refresh])

  const withdrawn = useCallback((linkId: string) => {
    setLinks(
      (value) =>
        value?.map((item) => (item.linkId === linkId ? { ...item, status: 'revoked' } : item)) ??
        value,
    )
  }, [])

  return { links, error, refresh, withdrawn }
}

const waitingNow = (link: PairingLink, now: number) =>
  link.status === 'waiting' && Date.parse(link.expiresAt) > now

/**
 * Every link still waiting for a device, so one made and closed is not lost.
 * Links this tab made can be shown and copied again; one made elsewhere can
 * only be withdrawn, since its token never reached this tab.
 */
function PairingLinks({
  state,
  ...props
}: {
  client: EnvironmentClient
  environmentId: string
  state: PairingLinksState
  currentClientId: string
  deviceLabel: (clientId: string) => string | undefined
  onShow?: (link: ShownPairingLink) => void
}) {
  // Only a waiting link needs the every-second clock.
  const waiting = state.links?.some((item) => item.status === 'waiting') ?? false
  return (
    <>
      {waiting ? <WaitingLinks state={state} {...props} /> : null}
      {state.error ? (
        <div className="mt-2 flex items-center gap-2">
          <Note role="alert">Could not read the pairing links: {state.error}</Note>
          <Button type="button" variant="tertiary" size="compact" onClick={state.refresh}>
            Retry
          </Button>
        </div>
      ) : null}
    </>
  )
}

function WaitingLinks({
  client,
  environmentId,
  state,
  currentClientId,
  deviceLabel,
  onShow,
}: {
  client: EnvironmentClient
  environmentId: string
  state: PairingLinksState
  currentClientId: string
  deviceLabel: (clientId: string) => string | undefined
  onShow?: (link: ShownPairingLink) => void
}) {
  const now = useNow(1000)
  const [withdrawing, setWithdrawing] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // This tab's own copies; a few short entries, so reading them each tick is cheap.
  const made = madePairingLinks(environmentId)
  const shown = (state.links ?? [])
    .filter((item) => waitingNow(item, now))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
  if (shown.length === 0) return null

  const withdraw = async (link: PairingLink) => {
    setWithdrawing(link.linkId)
    setError(null)
    try {
      await client.commands.revokePairingLink(link.linkId)
      state.withdrawn(link.linkId)
      forgetPairingLinks(environmentId, [link.linkId])
    } catch (caught) {
      setError(message(caught))
    } finally {
      setWithdrawing(null)
      state.refresh()
    }
  }

  return (
    <>
      <h3 className="mt-4 text-[12px] text-muted-foreground">Pairing links</h3>
      <ul className="mt-1.5 flex flex-col gap-1" aria-label="Pairing links">
        {shown.map((item) => (
          <PairingLinkRow
            key={item.linkId}
            link={item}
            made={made.get(item.linkId)}
            now={now}
            origin={
              item.createdByClientId === currentClientId
                ? 'Made on this device'
                : `Made on ${deviceLabel(item.createdByClientId) ?? 'another device'}`
            }
            busy={withdrawing === item.linkId}
            onShow={onShow}
            onCopyFailed={() =>
              setError('Could not copy. Open the QR code to select the link yourself.')
            }
            onWithdraw={() => void withdraw(item)}
          />
        ))}
      </ul>
      {error ? <Note role="alert">{error}</Note> : null}
    </>
  )
}

function PairingLinkRow({
  link,
  made,
  now,
  origin,
  busy,
  onShow,
  onCopyFailed,
  onWithdraw,
}: {
  link: PairingLink
  /** This tab's copy of the link, when this tab made it. */
  made: MadePairingLink | undefined
  now: number
  /** Where a link this tab cannot show was made. */
  origin: string
  busy: boolean
  onShow?: (link: ShownPairingLink) => void
  onCopyFailed: () => void
  onWithdraw: () => void
}) {
  const name = link.label ?? 'New device'
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1400)
    return () => clearTimeout(timer)
  }, [copied])
  const copy = async (url: string) => {
    // Without a secure origin there is no `navigator.clipboard` at all.
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
    } catch {
      onCopyFailed()
    }
  }
  const details = [
    describeAccess(link.capabilities),
    `Expires in ${formatRemaining(link.expiresAt, now) ?? '0:00'}`,
    ...(made ? [] : [origin]),
  ]
  return (
    <li className="flex items-center gap-3 rounded-lg bg-hover/70 px-3 py-2.5" aria-label={name}>
      <span aria-hidden className="flex shrink-0 text-muted-foreground">
        <LinkSimpleIcon size={16} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] text-foreground">{name}</div>
        <div className="truncate text-[12px] text-muted-foreground">{details.join(' · ')}</div>
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        {made && onShow ? (
          <IconAction
            label="Show QR code"
            disabled={busy}
            onClick={() => onShow({ link, url: made.url })}
          >
            <QrCodeIcon />
          </IconAction>
        ) : null}
        {made ? (
          <IconAction
            label={copied ? 'Copied' : 'Copy link'}
            disabled={busy}
            onClick={() => void copy(made.url)}
          >
            {copied ? <CheckIcon weight="bold" /> : <CopyIcon />}
          </IconAction>
        ) : null}
        <IconAction label="Withdraw link" disabled={busy} onClick={onWithdraw}>
          <XIcon />
        </IconAction>
      </div>
    </li>
  )
}

function IconAction({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string
  disabled: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <Tooltip content={label} side="bottom">
      <Button
        type="button"
        variant="ghost"
        size="icon-compact"
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
      >
        {children}
      </Button>
    </Tooltip>
  )
}

function DeviceRow({
  device,
  now,
  isCurrent,
  canRotate,
  canRename,
  renaming,
  busy,
  onStartRename,
  onCancelRename,
  onRename,
  onRevoke,
  onRotate,
}: {
  device: AuthorizedClient
  now: number
  isCurrent: boolean
  canRotate: boolean
  canRename: boolean
  renaming: boolean
  busy: boolean
  onStartRename: () => void
  onCancelRename: () => void
  onRename: (label: string) => void
  onRevoke: () => void
  onRotate: () => void
}) {
  const Glyph = KIND_ICONS[device.kind]
  // Neither the owner nor this device can be revoked from here: the owner is
  // rotated instead, and a device is revoked from another one.
  const revocable = !isCurrent && device.kind !== 'owner'
  // Leaving the name field puts focus back where the edit started.
  const renameButton = useRef<HTMLButtonElement>(null)
  const wasRenaming = useRef(renaming)
  useEffect(() => {
    if (wasRenaming.current && !renaming) renameButton.current?.focus()
    wasRenaming.current = renaming
  }, [renaming])
  return (
    <li
      // On a phone the actions take their own line under the device, so its
      // name and tags keep the row's width.
      className="flex items-center gap-3 rounded-lg bg-hover/70 px-3 py-2.5 max-sm:flex-wrap max-sm:gap-y-1.5"
      aria-label={device.label}
    >
      <span aria-hidden className="flex shrink-0 text-muted-foreground">
        <Glyph size={16} />
      </span>
      <div className="min-w-0 flex-1">
        {renaming ? (
          <RenameForm
            label={device.label}
            busy={busy}
            onCancel={onCancelRename}
            onSave={onRename}
          />
        ) : (
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span className="min-w-0 max-w-full truncate text-[13px] text-foreground">
              {device.label}
            </span>
            {isCurrent ? <Tag>This device</Tag> : null}
            {device.kind === 'owner' ? <Tag>Owner</Tag> : null}
          </div>
        )}
        <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
          <span
            aria-hidden
            className={cn(
              'h-1.5 w-1.5 shrink-0 rounded-full',
              device.connected ? 'bg-emerald-400' : 'bg-[var(--basis-text-faint)]',
            )}
          />
          <span className="truncate">
            {describePresence(device, now)} · {describeAccess(device.capabilities)}
          </span>
        </div>
      </div>
      {renaming ? null : (
        <div className="flex shrink-0 items-center gap-1 max-sm:basis-full max-sm:pl-5">
          {canRename ? (
            <Button
              ref={renameButton}
              type="button"
              variant="ghost"
              size="compact"
              disabled={busy}
              aria-label={`Rename ${device.label}`}
              onClick={onStartRename}
            >
              Rename
            </Button>
          ) : null}
          {revocable ? (
            <Button
              type="button"
              variant="ghost"
              size="compact"
              disabled={busy}
              aria-label={`Revoke ${device.label}`}
              onClick={onRevoke}
            >
              Revoke
            </Button>
          ) : null}
          {canRotate ? (
            <Button type="button" variant="ghost" size="compact" disabled={busy} onClick={onRotate}>
              Rotate credential
            </Button>
          ) : null}
        </div>
      )}
    </li>
  )
}

function Tag({ children }: { children: ReactNode }) {
  return (
    <span className="shrink-0 rounded px-1.5 py-px text-[11px] text-muted-foreground bg-active">
      {children}
    </span>
  )
}

function RenameForm({
  label,
  busy,
  onCancel,
  onSave,
}: {
  label: string
  busy: boolean
  onCancel: () => void
  onSave: (label: string) => void
}) {
  const [value, setValue] = useState(label)
  const trimmed = value.trim()
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!trimmed) return
    if (trimmed === label) onCancel()
    else onSave(trimmed)
  }
  return (
    <form className="flex items-center gap-1.5" onSubmit={submit}>
      <input
        type="text"
        aria-label="Device name"
        autoComplete="off"
        spellCheck={false}
        // Focus belongs in the field the person just asked to edit.
        autoFocus
        maxLength={CLIENT_LABEL_MAX_LENGTH}
        className={fieldClass}
        value={value}
        disabled={busy}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            onCancel()
          }
        }}
      />
      <Button type="submit" variant="secondary" size="compact" disabled={busy || !trimmed}>
        {busy ? 'Saving…' : 'Save'}
      </Button>
      <Button type="button" variant="ghost" size="compact" disabled={busy} onClick={onCancel}>
        Cancel
      </Button>
    </form>
  )
}

function copyFor(confirm: Confirm) {
  switch (confirm.kind) {
    case 'revoke':
      return {
        title: `Revoke ${confirm.client.label}?`,
        description: `${confirm.client.label} loses access now, and any connection it has open is closed. To use it again, pair it with a new link.`,
        action: 'Revoke',
        busy: 'Revoking…',
      }
    case 'revoke_others':
      return {
        title: 'Revoke all other devices?',
        description: `${confirm.count === 1 ? '1 device loses' : `${confirm.count} devices lose`} access now, and their open connections are closed. This device and the owner keep theirs.`,
        action: 'Revoke all',
        busy: 'Revoking…',
      }
    case 'rotate':
      return {
        title: 'Rotate the owner credential?',
        description:
          'This browser switches to a new credential and reconnects. Anything else using the old one is disconnected; it can read the new one from the environment’s data directory.',
        action: 'Rotate',
        busy: 'Rotating…',
      }
  }
}

function ConfirmDialog({
  confirm,
  open,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  confirm: Confirm | null
  open: boolean
  busy: boolean
  error: string | null
  onCancel: () => void
  onConfirm: () => void
}) {
  const copy = confirm ? copyFor(confirm) : null
  return (
    <Dialog
      open={open}
      onOpenChange={(open) => {
        if (!open) onCancel()
      }}
    >
      <DialogContent appearance="float" showCloseButton={!busy}>
        {copy ? (
          <>
            <DialogHeader>
              <DialogTitle>{copy.title}</DialogTitle>
              <DialogDescription>{copy.description}</DialogDescription>
            </DialogHeader>
            {error ? (
              <p role="alert" className="text-[12px] text-destructive">
                {error}
              </p>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>
                Cancel
              </Button>
              <Button type="button" variant="primary" disabled={busy} onClick={onConfirm}>
                {busy ? copy.busy : copy.action}
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
