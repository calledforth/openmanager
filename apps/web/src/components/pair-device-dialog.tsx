import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import {
  encodePairingLink,
  isEnvironmentClientError,
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
import { useNow } from '@openmanager/app-core/lib/relative-time'
import { isLoopbackEnvironmentEndpoint, type EnvironmentRoute } from '../lib/environment-store'
import { isLoopbackAppUrl } from '../lib/pairing'
import { cn } from '../lib/utils'

/** Every capability but `read`, which any useful grant holds, in the order they are offered. */
const OPTIONAL_CAPABILITIES: ReadonlyArray<{
  capability: Exclude<AccessCapability, 'read'>
  label: string
  detail: string
}> = [
  {
    capability: 'operate',
    label: 'Edit',
    detail: 'Create and rename sessions, change files, use git.',
  },
  { capability: 'agent', label: 'Run agents', detail: 'Send prompts and answer what agents ask.' },
  { capability: 'terminal', label: 'Terminals', detail: 'Open and type into terminals.' },
  {
    capability: 'admin',
    label: 'Manage access',
    detail: 'Pair and revoke devices, like this one.',
  },
]

/** The two presets. Manage access is never part of one: it is always its own tick. */
const PRESETS: ReadonlyArray<{ id: string; label: string; grant: readonly AccessCapability[] }> = [
  { id: 'view', label: 'View only', grant: ['read'] },
  { id: 'full', label: 'Full access', grant: ['read', 'operate', 'agent', 'terminal'] },
]

const fieldClass =
  'h-7 w-full min-w-0 rounded-md bg-hover px-2 text-[13px] text-foreground outline-none transition-colors duration-100 placeholder:text-faint focus:bg-active disabled:opacity-60'

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * The route a link should carry: the one in use when another device could
 * reach it too, else the first saved route that is not this computer's own
 * loopback address, else the one in use.
 */
export function defaultPairingRoute(
  routes: readonly EnvironmentRoute[],
  inUse: string | null,
): string | null {
  if (inUse && !isLoopbackEnvironmentEndpoint(inUse)) return inUse
  return (
    routes.find((route) => !isLoopbackEnvironmentEndpoint(route.endpoint))?.endpoint ??
    inUse ??
    routes[0]?.endpoint ??
    null
  )
}

/** "4:05" until a time, or null once it has passed. */
export function formatRemaining(until: string, now: number): string | null {
  const seconds = Math.ceil((Date.parse(until) - now) / 1000)
  if (!(seconds > 0)) return null
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

type Created = { link: PairingLink; url: string }

/**
 * Make a single-use pairing link and show it as a QR code and a link to copy.
 * The token exists only in this dialog's memory: the environment keeps its
 * hash, so a link that is closed cannot be shown again, only made anew. It
 * stays usable until it is used, withdrawn or five minutes pass, so a link
 * already sent somewhere keeps working after the dialog closes.
 */
export function PairDeviceDialog({
  client,
  open,
  onOpenChange,
  grant,
  environmentId,
  routes,
  inUseEndpoint,
  appUrl,
  deviceLabel,
}: {
  client: EnvironmentClient
  open: boolean
  onOpenChange: (open: boolean) => void
  /** What this device holds; a link can offer no more. */
  grant: readonly AccessCapability[]
  environmentId: string
  routes: readonly EnvironmentRoute[]
  inUseEndpoint: string | null
  /** Where this web app is served: the page the link opens. */
  appUrl: string
  /** The paired device's name by its client ID, once the device list knows it. */
  deviceLabel: (clientId: string) => string | undefined
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent appearance="float">
        {open ? (
          <PairDeviceFlow
            client={client}
            grant={grant}
            environmentId={environmentId}
            routes={routes}
            inUseEndpoint={inUseEndpoint}
            appUrl={appUrl}
            deviceLabel={deviceLabel}
            onClose={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function PairDeviceFlow({
  client,
  grant,
  environmentId,
  routes,
  inUseEndpoint,
  appUrl,
  deviceLabel,
  onClose,
}: {
  client: EnvironmentClient
  grant: readonly AccessCapability[]
  environmentId: string
  routes: readonly EnvironmentRoute[]
  inUseEndpoint: string | null
  appUrl: string
  deviceLabel: (clientId: string) => string | undefined
  onClose: () => void
}) {
  const [created, setCreated] = useState<Created | null>(null)
  if (created) {
    return (
      <LinkView
        client={client}
        created={created}
        deviceLabel={deviceLabel}
        onAnother={() => setCreated(null)}
        onClose={onClose}
      />
    )
  }
  return (
    <SetupForm
      client={client}
      grant={grant}
      environmentId={environmentId}
      routes={routes}
      inUseEndpoint={inUseEndpoint}
      appUrl={appUrl}
      onCreated={setCreated}
      onClose={onClose}
    />
  )
}

function SetupForm({
  client,
  grant,
  environmentId,
  routes,
  inUseEndpoint,
  appUrl,
  onCreated,
  onClose,
}: {
  client: EnvironmentClient
  grant: readonly AccessCapability[]
  environmentId: string
  routes: readonly EnvironmentRoute[]
  inUseEndpoint: string | null
  appUrl: string
  onCreated: (created: Created) => void
  onClose: () => void
}) {
  const offered = OPTIONAL_CAPABILITIES.filter((item) => grant.includes(item.capability))
  const [chosen, setChosen] = useState<AccessCapability[]>(() =>
    PRESETS[1]!.grant.filter((capability) => grant.includes(capability)),
  )
  const [label, setLabel] = useState('')
  const [route, setRoute] = useState(() => defaultPairingRoute(routes, inUseEndpoint))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const toggle = (capability: AccessCapability) =>
    setChosen((current) =>
      current.includes(capability)
        ? current.filter((item) => item !== capability)
        : [...current, capability],
    )
  const runsCode = chosen.includes('agent') || chosen.includes('terminal')
  const managesAccess = chosen.includes('admin')
  const loopbackRoute = route !== null && isLoopbackEnvironmentEndpoint(route)
  const loopbackApp = isLoopbackAppUrl(appUrl)

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!route) return
    setBusy(true)
    setError(null)
    try {
      const capabilities = ['read' as const, ...chosen.filter((item) => item !== 'read')]
      const trimmed = label.trim()
      const answer = await client.commands.createPairingLink({
        capabilities,
        ...(trimmed ? { label: trimmed } : {}),
      })
      onCreated({
        link: answer.link,
        url: encodePairingLink(appUrl, { route, environmentId, token: answer.token }),
      })
    } catch (caught) {
      setError(
        isEnvironmentClientError(caught) && caught.code === 'capability_missing'
          ? 'This device cannot offer that much access. Untick what it does not hold.'
          : message(caught),
      )
      setBusy(false)
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)}>
      <DialogHeader>
        <DialogTitle>Pair a device</DialogTitle>
        <DialogDescription>
          Make a single-use link for a phone or another browser. It opens OpenManager there and
          gives that device its own access, which you can revoke here at any time.
        </DialogDescription>
      </DialogHeader>

      <fieldset className="mt-4" disabled={busy}>
        <legend className="text-[12px] text-muted-foreground">Access</legend>
        <div className="mt-1.5 flex flex-wrap gap-1.5" role="group" aria-label="Presets">
          {PRESETS.filter((preset) => preset.grant.every((item) => grant.includes(item))).map(
            (preset) => (
              <Button
                key={preset.id}
                type="button"
                variant="ghost"
                size="compact"
                onClick={() => setChosen([...preset.grant])}
              >
                {preset.label}
              </Button>
            ),
          )}
        </div>
        <ul className="mt-1.5 flex flex-col gap-1">
          <Choice checked disabled label="View" detail="Projects, sessions, files and history." />
          {offered.map((item) => (
            <Choice
              key={item.capability}
              checked={chosen.includes(item.capability)}
              label={item.label}
              detail={item.detail}
              onChange={() => toggle(item.capability)}
            />
          ))}
        </ul>
        {runsCode ? (
          <Warning>Runs code on this machine: agents and terminals run as you do here.</Warning>
        ) : null}
        {managesAccess ? (
          <Warning>
            Manages access: the device can pair new devices and revoke any but the owner.
          </Warning>
        ) : null}
      </fieldset>

      <label className="mt-4 block text-[12px] text-muted-foreground" htmlFor="pair-link-label">
        Device name <span className="text-faint">(optional)</span>
      </label>
      <input
        id="pair-link-label"
        type="text"
        autoComplete="off"
        spellCheck={false}
        maxLength={CLIENT_LABEL_MAX_LENGTH}
        placeholder="Let the device name itself"
        className={cn(fieldClass, 'mt-1.5')}
        value={label}
        disabled={busy}
        onChange={(event) => setLabel(event.target.value)}
      />

      {routes.length > 1 ? (
        <>
          <label className="mt-4 block text-[12px] text-muted-foreground" htmlFor="pair-link-route">
            Address the device uses
          </label>
          <select
            id="pair-link-route"
            className={cn(fieldClass, 'mt-1.5')}
            value={route ?? ''}
            disabled={busy}
            onChange={(event) => setRoute(event.target.value)}
          >
            {routes.map((item) => (
              <option key={item.endpoint} value={item.endpoint}>
                {item.endpoint}
              </option>
            ))}
          </select>
        </>
      ) : null}
      {loopbackRoute ? (
        <Warning>
          The device will reach the environment at {route}, which only works on this computer. To
          pair a phone, add an address it can reach (a LAN or tunnel URL) under Environments first.
        </Warning>
      ) : null}
      {loopbackApp ? (
        <Warning>
          This page is open at {new URL(appUrl).host}, so the link opens only on this computer.
        </Warning>
      ) : null}

      {error ? (
        <p role="alert" className="mt-3 text-[12px] text-destructive">
          {error}
        </p>
      ) : null}
      <DialogFooter className="mt-5">
        <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={busy || !route}>
          {busy ? 'Creating…' : 'Create link'}
        </Button>
      </DialogFooter>
    </form>
  )
}

function Choice({
  checked,
  disabled = false,
  label,
  detail,
  onChange,
}: {
  checked: boolean
  disabled?: boolean
  label: string
  detail: string
  onChange?: () => void
}) {
  return (
    <li>
      <label
        className={cn(
          // Selection is a fill, never an outline.
          'flex cursor-pointer items-start gap-2.5 rounded-md px-2.5 py-1.5 transition-colors duration-100',
          'has-[:focus-visible]:ring-1 has-[:focus-visible]:ring-focus-ring',
          checked ? 'bg-active' : 'hover:bg-hover',
          disabled && 'cursor-default',
        )}
      >
        <input
          type="checkbox"
          className="mt-[3px] shrink-0 accent-current"
          checked={checked}
          disabled={disabled}
          onChange={onChange}
        />
        <span className="flex min-w-0 flex-col">
          <span className="text-[13px] text-foreground">{label}</span>
          <span className="text-[12px] text-muted-foreground">{detail}</span>
        </span>
      </label>
    </li>
  )
}

function Warning({ children }: { children: ReactNode }) {
  return <p className="mt-2 text-[12px] text-[var(--basis-session-cube-needs)]">{children}</p>
}

/** The link once made: a QR code, the link to copy, and what became of it. */
function LinkView({
  client,
  created,
  deviceLabel,
  onAnother,
  onClose,
}: {
  client: EnvironmentClient
  created: Created
  deviceLabel: (clientId: string) => string | undefined
  onAnother: () => void
  onClose: () => void
}) {
  const [link, setLink] = useState(created.link)
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const now = useNow(1000)
  const remaining = formatRemaining(link.expiresAt, now)
  const status = link.status === 'waiting' && remaining === null ? 'expired' : link.status

  // The device list hears a device pair; that is the moment to ask what
  // became of this link. Reading the link list again is cheap and says which
  // device used it.
  const linkId = created.link.linkId
  const generation = useRef(0)
  useEffect(() => {
    const refresh = () => {
      const current = ++generation.current
      client.commands.listPairingLinks().then(
        (links) => {
          const found = links.find((item) => item.linkId === linkId)
          if (found && current === generation.current) setLink(found)
        },
        () => undefined,
      )
    }
    const stop = client.onAuthorizedClientsChanged?.(refresh)
    return () => {
      generation.current += 1
      stop?.()
    }
  }, [client, linkId])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(created.url)
      setCopied(true)
    } catch {
      setError('Could not copy. Select the link and copy it yourself.')
    }
  }

  const withdraw = async () => {
    setBusy(true)
    setError(null)
    try {
      await client.commands.revokePairingLink(linkId)
      setLink((current) => ({ ...current, status: 'revoked' }))
    } catch (caught) {
      setError(message(caught))
    } finally {
      setBusy(false)
    }
  }

  const usedBy = link.usedByClientId ? deviceLabel(link.usedByClientId) : undefined
  const waiting = status === 'waiting'

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {waiting ? 'Scan or open on the new device' : statusTitle(status)}
        </DialogTitle>
        <DialogDescription>
          {waiting
            ? 'Scan the code with the device’s camera, or send it the link. It works once.'
            : statusDetail(status, usedBy)}
        </DialogDescription>
      </DialogHeader>
      {waiting ? (
        <>
          <div className="mt-4 flex justify-center">
            {/* Dark on light, whatever the theme: that is what cameras read best. */}
            <div className="rounded-lg bg-white p-3">
              <QRCodeSVG
                value={created.url}
                size={184}
                level="L"
                bgColor="#ffffff"
                fgColor="#000000"
                role="img"
                aria-label="Pairing QR code"
              />
            </div>
          </div>
          <div className="mt-4 flex items-center gap-1.5">
            <input
              type="text"
              readOnly
              aria-label="Pairing link"
              className={fieldClass}
              value={created.url}
              onFocus={(event) => event.currentTarget.select()}
            />
            <Button type="button" variant="secondary" size="compact" onClick={() => void copy()}>
              {copied ? 'Copied' : 'Copy link'}
            </Button>
          </div>
          <p role="status" className="mt-2 text-[12px] text-muted-foreground">
            Waiting for a device · expires in {remaining}
          </p>
        </>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-[12px] text-destructive">
          {error}
        </p>
      ) : null}
      <DialogFooter className="mt-5">
        {waiting ? (
          <Button type="button" variant="ghost" disabled={busy} onClick={() => void withdraw()}>
            {busy ? 'Withdrawing…' : 'Withdraw link'}
          </Button>
        ) : (
          <Button type="button" variant="ghost" onClick={onAnother}>
            Pair another device
          </Button>
        )}
        <Button type="button" variant="primary" onClick={onClose}>
          Done
        </Button>
      </DialogFooter>
    </>
  )
}

function statusTitle(status: PairingLink['status']): string {
  switch (status) {
    case 'used':
      return 'Device paired'
    case 'expired':
      return 'The link expired'
    case 'revoked':
      return 'Link withdrawn'
    case 'void':
      return 'The link no longer works'
    case 'waiting':
      return 'Waiting for a device'
  }
}

function statusDetail(status: PairingLink['status'], usedBy: string | undefined): string {
  switch (status) {
    case 'used':
      return `${usedBy ?? 'A device'} can now reach this environment. It is in the device list, where you can rename or revoke it.`
    case 'expired':
      return 'Nobody used it within five minutes. Make another when the device is ready.'
    case 'revoked':
      return 'Nobody can use it now.'
    case 'void':
      return 'The device that made it lost access, so the link stopped working.'
    case 'waiting':
      return ''
  }
}
