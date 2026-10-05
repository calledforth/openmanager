import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { createFileRoute, useNavigate, useRouterState } from '@tanstack/react-router'
import {
  parsePairingLink,
  type EnvironmentClient,
  type PairingPayload,
} from '@openmanager/environment-client'
import { CLIENT_LABEL_MAX_LENGTH } from '@openmanager/protocol'
import { Button } from '@openmanager/app-core/components/fluid/ui/button'
import {
  useEnvironmentClientOptional,
  useEnvironmentState,
} from '@openmanager/app-core/providers/environment-client'
import { findStoredEnvironment } from '../lib/environment-store'
import {
  exchangePairingToken,
  pairingRejectionMessage,
  pairingRejectionReason,
  suggestDeviceLabel,
} from '../lib/pairing'
import { useConnection } from '../providers/connection-provider'

export const Route = createFileRoute('/pair')({ component: PairPage })

/**
 * The link this tab is pairing with, and whether it is waiting to redeem it.
 * The page takes the link out of the address bar as soon as it has read it,
 * and the shell remounts the page when the environment's connection comes or
 * goes, so both are held here until pairing ends. Only in memory: a reload
 * loses them, and the person opens the link again.
 */
let held: { payload: PairingPayload; redeeming: boolean } | null = null
/**
 * When this tab last finished pairing. The connection it opens can remount
 * the page before the session list has loaded, and that page must not ask
 * for a link it has just used.
 */
let pairedAt: number | null = null
const PAIRED_GRACE_MS = 10_000

type Step =
  | { kind: 'confirm' }
  | { kind: 'pairing' }
  /** An environment this browser already has: redeemed over its own socket once it connects. */
  | { kind: 'redeeming' }
  | { kind: 'failed'; message: string }

const fieldClass =
  'h-9 w-full rounded-lg bg-hover/70 px-3 text-[15px] outline-none transition-colors duration-100 placeholder:text-faint focus:bg-hover disabled:opacity-60'

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * Where a pairing link lands on the new device. A browser with no credential
 * for the environment trades the link's token for its own at the link's
 * route and saves it; one that already has a credential redeems the link over
 * the socket it already trusts, so its credential never goes to an address a
 * link named. Either way it ends in the session list.
 */
function PairPage() {
  const hash = useRouterState({ select: (state) => state.location.hash })
  const navigate = useNavigate()
  const [link] = useState(() => {
    if (hash) {
      const parsed = parsePairingLink(`#${hash}`)
      held = parsed.ok ? { payload: parsed.payload, redeeming: false } : null
      pairedAt = null
      return parsed
    }
    return held ? { ok: true as const, payload: held.payload } : null
  })
  const [justPaired] = useState(
    () => !link && pairedAt !== null && Date.now() - pairedAt < PAIRED_GRACE_MS,
  )

  // The token is a secret until it is used: it leaves the address bar and the
  // history entry straight away.
  useEffect(() => {
    if (hash) void navigate({ to: '/pair', replace: true })
  }, [hash, navigate])

  useEffect(() => {
    if (justPaired) void navigate({ to: '/', replace: true })
  }, [justPaired, navigate])

  if (justPaired) {
    return (
      <PairLayout title="Paired">
        <Text>Opening your sessions…</Text>
      </PairLayout>
    )
  }
  if (!link) {
    return (
      <PairLayout title="Pair this browser">
        <Text>
          Open a pairing link from a device that manages the environment: in its settings, under
          Devices, choose Pair a device.
        </Text>
        <SessionsButton />
      </PairLayout>
    )
  }
  if (!link.ok) {
    return (
      <PairLayout title="This pairing link does not work">
        <Text>
          {link.reason === 'unsupported_version'
            ? 'It was made by a newer version of OpenManager. Update this app, then open the link again.'
            : 'Part of it is missing or was changed. Copy the whole link again, or scan the QR code.'}
        </Text>
        <SessionsButton />
      </PairLayout>
    )
  }
  return <PairWithLink payload={link.payload} />
}

function PairWithLink({ payload }: { payload: PairingPayload }) {
  const navigate = useNavigate()
  const { environments, environment, selectEnvironment, addPairedEnvironment } = useConnection()
  const client = useEnvironmentClientOptional()
  const saved = findStoredEnvironment(environments, payload.environmentId)
  // Read once: saving the new credential must not turn this into a redeem.
  const [alreadySaved] = useState(() => Boolean(saved?.credential))
  const [step, setStepState] = useState<Step>(() =>
    held?.payload === payload && held.redeeming ? { kind: 'redeeming' } : { kind: 'confirm' },
  )
  const setStep = (next: Step) => {
    if (held?.payload === payload) held = { payload, redeeming: next.kind === 'redeeming' }
    setStepState(next)
  }
  const [label, setLabel] = useState(() =>
    suggestDeviceLabel(typeof navigator === 'undefined' ? '' : navigator.userAgent),
  )

  const leave = () => {
    held = null
    void navigate({ to: '/', replace: true })
  }
  const finish = () => {
    pairedAt = Date.now()
    leave()
  }

  const exchange = async () => {
    setStep({ kind: 'pairing' })
    try {
      const answer = await exchangePairingToken(payload.route, {
        token: payload.token,
        label: label.trim() || undefined,
      })
      // The link's route answered for another environment than the link
      // names. Its credential stays unsaved: nothing says what it opens.
      if (answer.environmentId !== payload.environmentId) {
        setStep({
          kind: 'failed',
          message:
            'The address in this link answered as a different environment than the link names, so nothing was saved.',
        })
        return
      }
      const added = addPairedEnvironment({
        environmentId: answer.environmentId,
        endpoint: payload.route,
        label: answer.label,
        credential: answer.credential,
      })
      if (!added) {
        setStep({
          kind: 'failed',
          message:
            'This browser was paired with the environment from another tab meanwhile, so its credential was kept. Open the link again to update its access.',
        })
        return
      }
      finish()
    } catch (error) {
      setStep({ kind: 'failed', message: message(error) })
    }
  }

  const redeem = () => {
    if (environment.status !== 'selected' || environment.environmentId !== payload.environmentId) {
      selectEnvironment(payload.environmentId)
    }
    setStep({ kind: 'redeeming' })
  }

  const busy = step.kind === 'pairing' || step.kind === 'redeeming'
  const host = routeHost(payload.route)
  const environmentName = saved?.label

  return (
    <PairLayout
      title={
        alreadySaved && environmentName ? `Pair again with ${environmentName}` : 'Pair this browser'
      }
    >
      {alreadySaved ? (
        <Text>
          This browser already reaches {environmentName ?? 'this environment'}. Pairing again keeps
          its name and gives it the access this link offers. It uses the connection it already has,
          not the address in the link.
        </Text>
      ) : (
        <Text>
          This browser will be able to reach the environment at{' '}
          <span className="text-foreground">{host}</span>. Only continue if you made this link or
          trust whoever sent it.
        </Text>
      )}
      {step.kind === 'redeeming' && client ? (
        <Redeem
          client={client}
          token={payload.token}
          environmentId={payload.environmentId}
          onDone={finish}
          onFailed={(text) => setStep({ kind: 'failed', message: text })}
        />
      ) : null}
      {alreadySaved ? null : (
        <form
          className="mt-7 flex flex-col gap-2.5"
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault()
            void exchange()
          }}
        >
          <label className="text-[13px] text-muted-foreground" htmlFor="pair-device-name">
            Name for this browser
          </label>
          <input
            id="pair-device-name"
            type="text"
            autoComplete="off"
            spellCheck={false}
            maxLength={CLIENT_LABEL_MAX_LENGTH}
            className={fieldClass}
            value={label}
            disabled={busy}
            onChange={(event) => setLabel(event.target.value)}
          />
          <p className="text-[13px] text-muted-foreground">
            The device that made the link may have named it already; then that name is used.
          </p>
          <StepMessage step={step} />
          <Button type="submit" variant="primary" className="mt-2" disabled={busy}>
            {step.kind === 'pairing' ? 'Pairing…' : 'Pair this browser'}
          </Button>
          <Button type="button" variant="ghost" disabled={busy} onClick={leave}>
            Cancel
          </Button>
        </form>
      )}
      {alreadySaved ? (
        <div className="mt-7 flex flex-col gap-2.5">
          <StepMessage step={step} />
          <Button type="button" variant="primary" disabled={busy} onClick={redeem}>
            {step.kind === 'redeeming' ? 'Connecting…' : 'Update access'}
          </Button>
          <Button type="button" variant="ghost" onClick={leave}>
            Cancel
          </Button>
        </div>
      ) : null}
    </PairLayout>
  )
}

/**
 * Redeems the link once the socket to its environment is up. The client must
 * be the one for that environment: right after a selection changes, the
 * previous environment's client is still around for a moment.
 */
function Redeem({
  client,
  token,
  environmentId,
  onDone,
  onFailed,
}: {
  client: EnvironmentClient
  token: string
  environmentId: string
  onDone: () => void
  onFailed: (message: string) => void
}) {
  const { environment } = useConnection()
  const clientEnvironmentId = useEnvironmentState((state) => state.environment?.environmentId)
  const ready =
    environment.status === 'selected' &&
    environment.environmentId === environmentId &&
    clientEnvironmentId === environmentId
  const sent = useRef(false)
  const done = useRef(onDone)
  const failed = useRef(onFailed)
  useEffect(() => {
    done.current = onDone
    failed.current = onFailed
  })
  useEffect(() => {
    if (!ready || sent.current) return
    sent.current = true
    client.commands.redeemPairingLink({ token }).then(
      () => done.current(),
      (error: unknown) => {
        const reason = pairingRejectionReason(error)
        failed.current(reason ? pairingRejectionMessage(reason) : message(error))
      },
    )
  }, [client, ready, token])
  return null
}

function StepMessage({ step }: { step: Step }) {
  if (step.kind === 'failed') {
    return (
      <p role="alert" className="text-[13px] text-destructive">
        {step.message}
      </p>
    )
  }
  if (step.kind === 'redeeming') {
    return (
      <p role="status" className="text-[13px] text-muted-foreground">
        Connecting to the environment…
      </p>
    )
  }
  return null
}

function routeHost(route: string): string {
  try {
    return new URL(route).host
  } catch {
    return route
  }
}

function PairLayout({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-auto px-6 pb-24">
      <div className="flex w-full max-w-[340px] flex-col">
        <h1 className="text-[22px] font-semibold leading-[1.3] tracking-[-0.015em]">{title}</h1>
        {children}
      </div>
    </div>
  )
}

function Text({ children }: { children: ReactNode }) {
  return <p className="mt-1 text-[14px] text-muted-foreground">{children}</p>
}

function SessionsButton() {
  const navigate = useNavigate()
  return (
    <Button
      type="button"
      variant="secondary"
      className="mt-7"
      onClick={() => void navigate({ to: '/' })}
    >
      Go to sessions
    </Button>
  )
}
