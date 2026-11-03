import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import {
  KeyIcon,
  PlugsIcon,
  PlusIcon,
  PushPinSimpleIcon,
  TrashIcon,
  XIcon,
} from '@phosphor-icons/react'
import { Button } from '@openmanager/app-core/components/fluid/ui/button'
import { phosphorIcon } from '@openmanager/app-core/components/fluid/lib/icon-context'
import { Tooltip } from '@openmanager/app-core/components/ui/Tooltip'
import {
  connectionActionLabel,
  connectionStatusLabel,
  type ConnectionAction,
  type ConnectionUiState,
  parseEnvironmentCredential,
  parseEnvironmentEndpoint,
  routeSearchOrder,
  routeTypeLabel,
  type EnvironmentRoute,
  type RouteHealthStatus,
  type StoredEnvironment,
  routeHealthLabel,
} from '@openmanager/environment-client/connection'
import { canClaimLocalOwner } from '../lib/local-owner'
import { cn } from '../lib/utils'
import type { AddRouteResult } from '../providers/connection-provider'

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
  compact = false,
}: {
  state: ConnectionUiState
  handlers: ConnectionHandlers
  className?: string
  extra?: ReactNode
  /**
   * Small text buttons with a hover fill, as the other floating notices
   * have, for the banner.
   */
  compact?: boolean
}) {
  return (
    <div className={cn('flex flex-wrap', compact ? 'gap-1.5' : 'gap-2', className)}>
      {extra}
      {state.action && state.action !== 'connect' ? (
        <Button
          type="button"
          variant={compact ? 'ghost' : 'secondary'}
          size={compact ? 'compact' : undefined}
          className={compact ? 'text-foreground' : undefined}
          onClick={() => runAction(state.action!, handlers)}
        >
          {connectionActionLabel(state.action)}
        </Button>
      ) : null}
      {state.secondaryAction ? (
        <Button
          type="button"
          variant="ghost"
          size={compact ? 'compact' : undefined}
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
  initialCredential = '',
  onDraftChange,
  onConnect,
  submitLabel = 'Connect',
  className,
  canClaimOwner = canClaimLocalOwner(),
}: {
  initialEndpoint?: string
  initialCredential?: string
  /** Each keystroke, for a caller that keeps the draft past a remount. */
  onDraftChange?: (draft: { endpoint: string; credential: string }) => void
  onConnect: (endpoint: string, credential: string) => void
  submitLabel?: string
  className?: string
  /** A blank token on localhost claims the owner credential (the dev shell only). */
  canClaimOwner?: boolean
}) {
  const [endpointValue, setEndpointValue] = useState(initialEndpoint)
  const [credentialValue, setCredentialValue] = useState(initialCredential)
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
      setError(
        'Enter the client token exactly as issued (letters, digits, and - _ . ~ only), or leave it blank.',
      )
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
        onChange={(event) => {
          setEndpointValue(event.target.value)
          onDraftChange?.({ endpoint: event.target.value, credential: credentialValue })
        }}
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
        onChange={(event) => {
          setCredentialValue(event.target.value)
          onDraftChange?.({ endpoint: endpointValue, credential: event.target.value })
        }}
      />
      <p className="text-[13px] text-muted-foreground">
        {canClaimOwner
          ? 'Leave it blank on localhost to use the owner token.'
          : "On the environment's computer, paste the token from owner-credential in ~/.openmanager. Elsewhere, open a pairing link instead."}
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

const AddIcon = phosphorIcon(PlusIcon)

const HEALTH_DOTS: Record<RouteHealthStatus, string> = {
  unknown: 'bg-[var(--basis-text-faint)]',
  available: 'bg-[var(--basis-session-cube-ready)]',
  unreachable: 'bg-[var(--basis-session-cube-needs)]',
  unauthorized: 'bg-[var(--basis-session-cube-needs)]',
}

/** A small icon button whose name is its tooltip. */
function IconAction({
  label,
  icon: Icon,
  onClick,
  disabled,
  className,
}: {
  label: string
  icon: typeof XIcon
  onClick: () => void
  disabled?: boolean
  className?: string
}) {
  return (
    <Tooltip content={label}>
      <Button
        type="button"
        variant="ghost"
        size="icon-compact"
        aria-label={label}
        disabled={disabled}
        className={className}
        onClick={onClick}
      >
        <Icon />
      </Button>
    </Tooltip>
  )
}

/**
 * One way to reach an environment: a health dot, the address and its kind.
 * The route in use is the filled row; any other row is pressed to use it.
 * Its own actions (make it the first choice, forget it) show on hover.
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
  const health = routeHealthLabel(route.health.status)
  const body = (
    <>
      <Tooltip content={route.health.message ? `${health}: ${route.health.message}` : health}>
        <span
          aria-hidden
          className={cn('size-1.5 shrink-0 rounded-full', HEALTH_DOTS[route.health.status])}
        />
      </Tooltip>
      <span className="min-w-0 truncate font-mono text-[12px] text-foreground/85">
        {route.endpoint}
      </span>
      <span className="shrink-0 text-[11px] text-faint">{routeTypeLabel(route.type)}</span>
      <span className="sr-only">
        {' · '}
        <span title={route.health.message}>{health}</span>
        {inUse ? ' · In use' : ''}
      </span>
    </>
  )
  return (
    <li
      className={cn(
        // The route in use is a fill, never an outline.
        'group/route flex h-8 items-center gap-1 rounded-md pr-0.5 transition-colors duration-100',
        inUse ? 'bg-active' : onUse ? 'hover:bg-hover' : '',
      )}
    >
      {onUse ? (
        <button
          type="button"
          aria-label={`Use ${route.endpoint}`}
          title="Use this route"
          onClick={onUse}
          className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md pl-2.5 text-left outline-none focus-visible:ring-1 focus-visible:ring-focus-ring"
        >
          {body}
        </button>
      ) : (
        <div className="flex h-full min-w-0 flex-1 items-center gap-2 pl-2.5">{body}</div>
      )}
      <div className="flex shrink-0 items-center opacity-0 transition-opacity duration-100 focus-within:opacity-100 group-hover/route:opacity-100 pointer-coarse:opacity-100">
        {onMakeFirst ? (
          <IconAction
            label={`Make ${route.endpoint} the first choice`}
            icon={PushPinSimpleIcon}
            onClick={onMakeFirst}
          />
        ) : null}
        {onForget ? (
          <IconAction label={`Forget ${route.endpoint}`} icon={XIcon} onClick={onForget} />
        ) : null}
      </div>
    </li>
  )
}

/**
 * Another address for a saved environment, typed in place. The address has
 * to answer as this environment; it joins as the last choice of route.
 */
function AddRouteControl({
  label,
  onAddRoute,
}: {
  label: string
  onAddRoute: (endpoint: string) => Promise<AddRouteResult>
}) {
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const close = () => {
    setOpen(false)
    setValue('')
    setError(null)
  }
  if (!open) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="compact"
        className="mt-0.5 self-start"
        leadingIcon={AddIcon}
        aria-label={`Add a route to ${label}`}
        onClick={() => setOpen(true)}
      >
        Add route
      </Button>
    )
  }
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!value.trim() || busy) return
    setBusy(true)
    setError(null)
    const result = await onAddRoute(value)
    setBusy(false)
    if (result.ok) close()
    else setError(result.message)
  }
  return (
    <form className="mt-1 px-0.5" onSubmit={(event) => void submit(event)}>
      <div className="flex items-center gap-1">
        <input
          type="text"
          inputMode="url"
          autoComplete="url"
          spellCheck={false}
          // Focus belongs in the field the person just asked for.
          autoFocus
          placeholder="https://home.example.com"
          aria-label={`New route to ${label}`}
          className={cn(fieldClass, 'h-8 min-w-0 flex-1 font-mono text-[12px]')}
          value={value}
          disabled={busy}
          onChange={(event) => {
            setError(null)
            setValue(event.target.value)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              close()
            }
          }}
        />
        <Button type="submit" variant="secondary" size="compact" disabled={busy || !value.trim()}>
          {busy ? 'Checking…' : 'Add'}
        </Button>
        <IconAction label="Cancel" icon={XIcon} disabled={busy} onClick={close} />
      </div>
      {error ? (
        <p role="alert" className="mt-1.5 px-1 text-[12px] text-destructive">
          {error}
        </p>
      ) : (
        <p className="mt-1.5 px-1 text-[12px] text-faint">
          It must answer as {label}. No token needed.
        </p>
      )}
    </form>
  )
}

export function EnvironmentList({
  environments,
  selectedId,
  inUseEndpoint,
  onSelect,
  onRemove,
  onDisconnect,
  onChooseRoute,
  onRemoveRoute,
  onAddRoute,
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
  /** Leave the selected environment without forgetting it. */
  onDisconnect?: () => void
  onChooseRoute?: (environmentId: string, endpoint: string) => void
  onRemoveRoute?: (environmentId: string, endpoint: string) => void
  /** Offers "Add route" on each environment. */
  onAddRoute?: (environmentId: string, endpoint: string) => Promise<AddRouteResult>
  /** Called when the list appears, so the health it shows is current. */
  onCheckRoutes?: () => void
}) {
  useEffect(() => {
    onCheckRoutes?.()
  }, [onCheckRoutes])

  if (environments.length === 0) return null

  return (
    <ul className="mt-3 flex w-full flex-col gap-2 text-left" aria-label="Saved environments">
      {environments.map((environment) => {
        const selected = environment.environmentId === selectedId
        // Where this environment's connection is, or would start.
        const current =
          (selected ? inUseEndpoint : undefined) ?? routeSearchOrder(environment)[0]!.endpoint
        return (
          <li
            key={environment.environmentId}
            aria-label={environment.label}
            className="flex flex-col rounded-lg bg-hover/70 p-1.5"
          >
            <div className="flex min-h-8 items-center gap-2 pl-2.5">
              <p className="flex min-w-0 flex-1 items-center gap-2">
                <Tooltip content={environment.environmentId}>
                  <span className="truncate text-[13px] font-medium text-foreground">
                    {environment.label}
                  </span>
                </Tooltip>
                {selected ? (
                  <span className="shrink-0 rounded bg-active px-1.5 py-px text-[11px] text-muted-foreground">
                    Current
                  </span>
                ) : null}
                <span className="sr-only">
                  {environment.credential ? 'Client token saved' : 'No client token'}
                </span>
                {environment.credential ? null : (
                  <Tooltip content="No client token saved: pair this browser, or add the environment again with its token.">
                    <KeyIcon
                      aria-hidden
                      className="size-3.5 shrink-0 text-[var(--basis-session-cube-needs)]"
                    />
                  </Tooltip>
                )}
              </p>
              <div className="flex shrink-0 items-center">
                {onSelect && !selected ? (
                  <Button
                    type="button"
                    variant="secondary"
                    size="compact"
                    className="mr-1"
                    aria-label={`Connect to ${environment.label}`}
                    onClick={() => onSelect(environment.environmentId)}
                  >
                    Connect
                  </Button>
                ) : null}
                {onDisconnect && selected ? (
                  <IconAction
                    label={`Disconnect from ${environment.label}`}
                    icon={PlugsIcon}
                    onClick={onDisconnect}
                  />
                ) : null}
                {onRemove ? (
                  <IconAction
                    label={`Remove ${environment.label}`}
                    icon={TrashIcon}
                    onClick={() => onRemove(environment.environmentId)}
                  />
                ) : null}
              </div>
            </div>
            <ul className="mt-0.5 flex flex-col" aria-label={`Routes to ${environment.label}`}>
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
            {onAddRoute ? (
              <AddRouteControl
                label={environment.label}
                onAddRoute={(endpoint) => onAddRoute(environment.environmentId, endpoint)}
              />
            ) : null}
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
    ? 'Connect to a saved environment, or add one by its URL.'
    : state.description

  // The one mark a screen keeps: a refused token is a key problem.
  const StateIcon = state.kind === 'unauthorized' ? KeyIcon : null

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

/**
 * Every connection state that leaves the page in place, as one floating
 * strip: the environment that cannot be reached, a spinner while the client
 * retries on its own, and the cause as one muted line. The host positions it
 * over the page, so it never moves what is underneath.
 *
 * A strip that is retrying, or that has nothing to press, is a polite status.
 * One that waits on a person (retries stopped) is an alert.
 */
export function ConnectionBanner({
  state,
  handlers = {},
  className,
}: {
  state: ConnectionUiState
  handlers?: ConnectionHandlers
  className?: string
}) {
  const needsPerson = !state.retrying && !!state.action
  return (
    <div
      className={cn(
        'flex w-full max-w-[640px] flex-wrap items-center gap-x-3 gap-y-1 rounded-[14px] bg-float py-2 pl-3.5 pr-2 shadow-float',
        className,
      )}
      role={needsPerson ? 'alert' : 'status'}
      aria-live={needsPerson ? 'assertive' : 'polite'}
    >
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-x-2 text-[13px] leading-5">
          <span className="font-medium text-foreground">{state.title}</span>
          <span className="sr-only">. </span>
          <span className="flex items-center gap-1.5 text-muted-foreground">
            {state.retrying ? (
              <span className="todo-progress-loader shrink-0" aria-hidden="true" />
            ) : null}
            {state.description}
          </span>
        </p>
        {state.detail ? <p className="text-[12px] leading-4 text-faint">{state.detail}</p> : null}
      </div>
      <ActionButtons className="shrink-0" state={state} handlers={handlers} compact />
    </div>
  )
}

export function ConnectionStatusChip({ state }: { state: ConnectionUiState }) {
  if (state.kind === 'no_environment') {
    return <p className="px-2 text-[12px] text-muted-foreground">No environment</p>
  }

  // A screen, or a strip that stopped retrying, is waiting on a person.
  const needsAttention =
    state.surface === 'screen' || (state.surface === 'banner' && !state.retrying && !!state.action)
  const tone =
    state.kind === 'ready'
      ? 'text-[var(--basis-session-cube-ready)]'
      : needsAttention
        ? 'text-[var(--basis-session-cube-needs)]'
        : 'text-[var(--basis-text-muted)]'

  return (
    <p className={cn('flex min-w-0 items-center gap-1.5 px-2 text-[12px]', tone)}>
      {state.retrying ? (
        <span className="todo-progress-loader shrink-0" aria-hidden="true" />
      ) : null}
      <span className="truncate">{connectionStatusLabel(state)}</span>
    </p>
  )
}
