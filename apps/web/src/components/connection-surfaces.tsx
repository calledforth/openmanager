import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import {
  CloudSlashIcon,
  KeyIcon,
  LinkBreakIcon,
  LockKeyIcon,
  PowerIcon,
  ProhibitIcon,
  SwapIcon,
  WifiSlashIcon,
  type Icon,
} from '@phosphor-icons/react'
import { Button } from '@openmanager/app-core/components/fluid/ui/button'
import {
  connectionActionLabel,
  type ConnectionAction,
  type ConnectionUiState,
} from '../lib/connection-state'
import {
  parseEnvironmentCredential,
  parseEnvironmentEndpoint,
  routeSearchOrder,
  routeTypeLabel,
  type EnvironmentRoute,
  type RouteHealthStatus,
  type StoredEnvironment,
} from '../lib/environment-store'
import { canClaimLocalOwner } from '../lib/local-owner'
import { routeHealthLabel } from '../lib/route-health'
import { cn } from '../lib/utils'

// Tend's connect field: borderless, sits on the hover tint and darkens on focus.
const fieldClass =
  'h-9 w-full rounded-lg bg-hover/70 px-3 text-[15px] outline-none transition-colors duration-100 placeholder:text-faint focus:bg-hover'

export type ConnectionHandlers = {
  onConnect?: (endpoint: string, credential?: string) => void
  onRetry?: () => void
  onChangeEnvironment?: () => void
  onConfirmRoute?: () => void
  onDeclineRoute?: () => void
  onSelectEnvironment?: (environmentId: string) => void
  onRemoveEnvironment?: (environmentId: string) => void
  onChooseRoute?: (environmentId: string, endpoint: string) => void
  onRemoveRoute?: (environmentId: string, endpoint: string) => void
  onCheckRoutes?: () => void
}

/**
 * One mark per thing that can be wrong, so failures that need different
 * fixes do not look alike: the tunnel (a cloud), the server (power), the
 * token (a key), the path (a broken link), this device (no wifi).
 */
function connectionIcon(state: ConnectionUiState): Icon | null {
  switch (state.reason) {
    case 'tunnel_down':
      return CloudSlashIcon
    case 'environment_offline':
      return PowerIcon
    case 'credential_rejected':
      return KeyIcon
    case 'route_refused':
      return ProhibitIcon
    case 'wrong_environment':
      return SwapIcon
    case 'route_down':
      return LinkBreakIcon
  }
  // No network on this device has no action; retries that stopped do.
  if (state.kind === 'offline') return state.action ? LinkBreakIcon : WifiSlashIcon
  if (state.kind === 'unauthorized') return LockKeyIcon
  return null
}

function runAction(action: ConnectionAction, handlers: ConnectionHandlers, endpoint?: string) {
  if (action === 'retry') handlers.onRetry?.()
  if (action === 'change_environment') handlers.onChangeEnvironment?.()
  if (action === 'confirm_route') handlers.onConfirmRoute?.()
  if (action === 'decline_route') handlers.onDeclineRoute?.()
  if (action === 'connect' && endpoint) handlers.onConnect?.(endpoint)
}

function ActionButtons({
  state,
  handlers,
  className,
  extra,
}: {
  state: ConnectionUiState
  handlers: ConnectionHandlers
  className?: string
  extra?: ReactNode
}) {
  return (
    <div className={cn('flex flex-wrap gap-2', className)}>
      {extra}
      {state.action && state.action !== 'connect' ? (
        <Button
          type="button"
          variant="secondary"
          onClick={() => runAction(state.action!, handlers)}
        >
          {connectionActionLabel(state.action)}
        </Button>
      ) : null}
      {state.secondaryAction ? (
        <Button
          type="button"
          variant="ghost"
          onClick={() => runAction(state.secondaryAction!, handlers)}
        >
          {connectionActionLabel(state.secondaryAction)}
        </Button>
      ) : null}
    </div>
  )
}

/**
 * The question a new address for a saved environment raises, for places that
 * are not behind the full connection screen. `state.kind` is `confirm_route`.
 */
export function RouteOfferPrompt({
  state,
  handlers,
  className,
}: {
  state: ConnectionUiState
  handlers: ConnectionHandlers
  className?: string
}) {
  return (
    <div className={cn('rounded-lg bg-hover/70 px-3 py-2.5', className)} role="alert">
      <p className="text-[13px] font-medium text-foreground">{state.title}</p>
      <p className="mt-1 text-[13px] text-muted-foreground">{state.description}</p>
      <ActionButtons className="mt-3" state={state} handlers={handlers} />
    </div>
  )
}

export function EnvironmentConnectForm({
  initialEndpoint = '',
  onConnect,
  submitLabel = 'Connect',
  className,
  canClaimOwner = canClaimLocalOwner(),
}: {
  initialEndpoint?: string
  onConnect: (endpoint: string, credential: string) => void
  submitLabel?: string
  className?: string
  /** A blank token on localhost claims the owner credential (the dev shell only). */
  canClaimOwner?: boolean
}) {
  const [endpointValue, setEndpointValue] = useState(initialEndpoint)
  const [credentialValue, setCredentialValue] = useState('')
  const [error, setError] = useState<string | null>(null)

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const endpoint = parseEnvironmentEndpoint(endpointValue)
    if (!endpoint) {
      setError('Enter an http(s) environment URL, for example http://127.0.0.1:43120.')
      return
    }
    const credential = parseEnvironmentCredential(credentialValue)
    if (credentialValue.trim() && !credential) {
      setError('Enter the client token exactly as issued (letters, digits, and - _ . ~ only), or leave it blank.')
      return
    }
    setError(null)
    onConnect(endpoint, credential)
  }

  return (
    <form className={cn('flex w-full flex-col gap-2.5 text-left', className)} onSubmit={submit}>
      <input
        name="endpoint"
        type="text"
        inputMode="url"
        autoComplete="url"
        spellCheck={false}
        placeholder="http://127.0.0.1:43120"
        aria-label="Environment endpoint"
        className={fieldClass}
        value={endpointValue}
        onChange={(event) => setEndpointValue(event.target.value)}
      />
      <input
        name="credential"
        type="password"
        autoComplete="off"
        spellCheck={false}
        placeholder="Client token (omc1.…)"
        aria-label="Client token"
        className={fieldClass}
        value={credentialValue}
        onChange={(event) => setCredentialValue(event.target.value)}
      />
      <p className="text-[13px] text-muted-foreground">
        {canClaimOwner
          ? 'The token is optional. Leave it blank on localhost to request the local owner token. It is stored with the environment, not with a particular URL.'
          : "On the environment's own computer, paste the token from owner-credential in its data directory (~/.openmanager by default). On another device, open a pairing link instead. The token is stored with the environment, not with a particular URL."}
      </p>
      {error ? (
        <p className="text-[13px] text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <Button type="submit" variant="secondary" className="mt-2">
        {submitLabel}
      </Button>
    </form>
  )
}

const HEALTH_TONES: Record<RouteHealthStatus, string> = {
  unknown: 'text-faint',
  available: 'text-[var(--basis-session-cube-ready)]',
  unreachable: 'text-[var(--basis-session-cube-needs)]',
  unauthorized: 'text-[var(--basis-session-cube-needs)]',
}

/**
 * One way to reach an environment: where it points, whether it answers, and
 * the choice to use it. The route in use needs no such choice, and neither
 * does the one selecting the environment would start with.
 */
function RouteRow({
  route,
  inUse,
  onUse,
  onMakeFirst,
  onForget,
}: {
  route: EnvironmentRoute
  inUse: boolean
  onUse?: () => void
  /** Keep the route in use as the first choice, for a route that took over. */
  onMakeFirst?: () => void
  onForget?: () => void
}) {
  return (
    <li className="flex items-center justify-between gap-2">
      <div className="min-w-0">
        <p className="truncate font-mono text-[12px] text-muted-foreground">{route.endpoint}</p>
        <p className="text-[12px] text-faint">
          {routeTypeLabel(route.type)}
          {' · '}
          <span className={HEALTH_TONES[route.health.status]} title={route.health.message}>
            {routeHealthLabel(route.health.status)}
          </span>
          {inUse ? ' · In use' : ''}
        </p>
      </div>
      <div className="flex shrink-0 gap-1">
        {onUse ? (
          <Button
            type="button"
            variant="secondary"
            size="compact"
            aria-label={`Use ${route.endpoint}`}
            onClick={onUse}
          >
            Use
          </Button>
        ) : null}
        {onMakeFirst ? (
          <Button
            type="button"
            variant="secondary"
            size="compact"
            aria-label={`Make ${route.endpoint} the first choice`}
            onClick={onMakeFirst}
          >
            Make first
          </Button>
        ) : null}
        {onForget ? (
          <Button
            type="button"
            variant="ghost"
            size="compact"
            aria-label={`Forget ${route.endpoint}`}
            onClick={onForget}
          >
            Forget
          </Button>
        ) : null}
      </div>
    </li>
  )
}

export function EnvironmentList({
  environments,
  selectedId,
  inUseEndpoint,
  onSelect,
  onRemove,
  onChooseRoute,
  onRemoveRoute,
  onCheckRoutes,
}: {
  environments: StoredEnvironment[]
  selectedId: string | null
  /**
   * The route the selected environment is reached through. Omitted, it is the
   * first route in search order, which is where a connection starts.
   */
  inUseEndpoint?: string | null
  onSelect?: (environmentId: string) => void
  onRemove?: (environmentId: string) => void
  onChooseRoute?: (environmentId: string, endpoint: string) => void
  onRemoveRoute?: (environmentId: string, endpoint: string) => void
  /** Called when the list appears, so the health it shows is current. */
  onCheckRoutes?: () => void
}) {
  useEffect(() => {
    onCheckRoutes?.()
  }, [onCheckRoutes])

  if (environments.length === 0) return null

  return (
    <ul className="mt-4 flex w-full flex-col gap-2 text-left" aria-label="Saved environments">
      {environments.map((environment) => {
        const selected = environment.environmentId === selectedId
        // Where this environment's connection is, or would start.
        const current =
          (selected ? inUseEndpoint : undefined) ?? routeSearchOrder(environment)[0]!.endpoint
        return (
          <li
            key={environment.environmentId}
            className={cn('rounded-lg px-3 py-2.5', selected ? 'bg-hover' : 'bg-hover/70')}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-[13px] font-medium text-foreground">
                  {environment.label}
                  {selected ? ' · Selected' : ''}
                </p>
                <p className="mt-0.5 font-mono text-[12px] text-faint">
                  {environment.environmentId}
                </p>
                <p className="mt-1 text-[12px] text-muted-foreground">
                  {environment.credential ? 'Client token saved' : 'No client token'}
                </p>
              </div>
              <div className="flex shrink-0 flex-col gap-1.5">
                {onSelect && !selected ? (
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => onSelect(environment.environmentId)}
                  >
                    Select
                  </Button>
                ) : null}
                {onRemove ? (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => onRemove(environment.environmentId)}
                  >
                    Remove
                  </Button>
                ) : null}
              </div>
            </div>
            <ul
              className="mt-2.5 flex flex-col gap-2"
              aria-label={`Routes to ${environment.label}`}
            >
              {environment.routes.map((route) => (
                <RouteRow
                  key={route.endpoint}
                  route={route}
                  inUse={selected && route.endpoint === current}
                  onUse={
                    onChooseRoute && route.endpoint !== current
                      ? () => onChooseRoute(environment.environmentId, route.endpoint)
                      : undefined
                  }
                  // A route that took over from the first choice can become it.
                  onMakeFirst={
                    onChooseRoute &&
                    selected &&
                    route.endpoint === current &&
                    route.endpoint !== environment.routes[0]!.endpoint
                      ? () => onChooseRoute(environment.environmentId, route.endpoint)
                      : undefined
                  }
                  onForget={
                    onRemoveRoute && environment.routes.length > 1
                      ? () => onRemoveRoute(environment.environmentId, route.endpoint)
                      : undefined
                  }
                />
              ))}
            </ul>
          </li>
        )
      })}
    </ul>
  )
}

export function ConnectionScreen({
  state,
  handlers = {},
  environments = [],
  selectedId = null,
  inUseEndpoint,
}: {
  state: ConnectionUiState
  handlers?: ConnectionHandlers
  environments?: StoredEnvironment[]
  selectedId?: string | null
  inUseEndpoint?: string | null
}) {
  const choosingSaved = state.kind === 'no_environment' && environments.length > 0
  const title = choosingSaved ? 'Select an environment' : state.title
  const description = choosingSaved
    ? 'Choose a saved environment and the route to reach it by, or add another endpoint. A second URL for an environment you already have is added to it as another route.'
    : state.description

  const StateIcon = connectionIcon(state)

  // Tend's connect page: a narrow column, vertically centred and lifted a
  // little above the middle.
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-auto px-6 pb-24">
      <div className="flex w-full max-w-[340px] flex-col">
        {StateIcon ? (
          <span
            className="mb-4 flex size-10 items-center justify-center rounded-xl bg-hover text-[var(--basis-session-cube-needs)]"
            aria-hidden
          >
            <StateIcon className="size-5" />
          </span>
        ) : null}
        <h1 className="text-[22px] font-semibold leading-[1.3] tracking-[-0.015em]">{title}</h1>
        <p className="mt-1 text-[14px] text-muted-foreground">{description}</p>
        {state.kind === 'no_environment' ? (
          <>
            <EnvironmentList
              environments={environments}
              selectedId={selectedId}
              inUseEndpoint={inUseEndpoint}
              onSelect={handlers.onSelectEnvironment}
              onRemove={handlers.onRemoveEnvironment}
              onChooseRoute={handlers.onChooseRoute}
              onRemoveRoute={handlers.onRemoveRoute}
              onCheckRoutes={handlers.onCheckRoutes}
            />
            <EnvironmentConnectForm
              className={choosingSaved ? 'mt-4' : 'mt-7'}
              initialEndpoint={state.endpoint}
              onConnect={(endpoint, credential) => handlers.onConnect?.(endpoint, credential)}
            />
          </>
        ) : (
          <ActionButtons className="mt-7" state={state} handlers={handlers} />
        )}
      </div>
    </div>
  )
}

export function ConnectionBanner({
  state,
  handlers = {},
}: {
  state: ConnectionUiState
  handlers?: ConnectionHandlers
}) {
  // An offline banner with no action recovers on its own once the network is
  // back, so it stays a polite status like connecting and reconnecting. A
  // banner that offers an action is waiting on a person, so it is assertive.
  const needsAction = state.kind === 'unreachable' || (state.kind === 'offline' && !!state.action)
  const live = !needsAction
  const StateIcon = connectionIcon(state)
  return (
    <div
      className={cn(
        'flex shrink-0 items-center justify-between gap-3 border-b px-5 py-2.5',
        needsAction
          ? 'border-[var(--basis-border)] bg-[var(--basis-surface)]'
          : 'border-[var(--basis-border-muted)] bg-[var(--basis-surface-elevated)]',
      )}
      role={live ? 'status' : 'alert'}
      aria-live={live ? 'polite' : 'assertive'}
    >
      <div className="flex min-w-0 items-start gap-3">
        {StateIcon ? (
          <span
            className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-hover text-[var(--basis-session-cube-needs)]"
            aria-hidden
          >
            <StateIcon className="size-4" />
          </span>
        ) : null}
        <div className="min-w-0">
          <p className="text-ui-sm font-medium text-[var(--basis-text-strong)]">{state.title}</p>
          <p className="mt-0.5 text-ui-xs leading-ui-normal text-[var(--basis-text-muted)]">
            {state.description}
          </p>
        </div>
      </div>
      <ActionButtons className="shrink-0" state={state} handlers={handlers} />
    </div>
  )
}

export function ConnectionStatusChip({ state }: { state: ConnectionUiState }) {
  if (state.kind === 'no_environment') {
    return (
      <p className="px-2 text-[12px] text-muted-foreground">No environment</p>
    )
  }

  const needsAttention =
    state.kind === 'confirm_route' ||
    state.kind === 'unauthorized' ||
    state.kind === 'incompatible_protocol' ||
    (state.kind === 'offline' && !!state.action)
  const tone =
    state.kind === 'ready'
      ? 'text-[var(--basis-session-cube-ready)]'
      : needsAttention
        ? 'text-[var(--basis-session-cube-needs)]'
        : 'text-[var(--basis-text-muted)]'

  return (
    <p className={cn('px-2 text-[12px]', tone)}>
      {state.kind === 'ready' ? 'Connected' : state.title}
      {state.environmentLabel ? ` · ${state.environmentLabel}` : ''}
    </p>
  )
}
