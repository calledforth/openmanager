import { useState, type FormEvent, type ReactNode } from 'react'
import {
  connectionActionLabel,
  type ConnectionAction,
  type ConnectionUiState,
} from '../lib/connection-state'
import { parseEnvironmentEndpoint } from '../lib/environment-store'
import { cn } from '../lib/utils'

const fieldClass =
  'w-full rounded-md border border-[var(--basis-border)] bg-[var(--basis-surface)] px-3 py-1.5 text-ui-sm text-[var(--basis-text)] outline-none focus-visible:border-[var(--basis-border-strong)]'
const primaryButtonClass =
  'rounded-md bg-[var(--basis-action-bg)] px-3 py-1.5 text-ui-sm text-[var(--basis-action-fg)] hover:bg-[var(--basis-action-hover)] disabled:opacity-50'
const secondaryButtonClass =
  'rounded-md border border-[var(--basis-border)] bg-[var(--basis-surface)] px-3 py-1.5 text-ui-sm text-[var(--basis-text)] hover:bg-[var(--basis-surface-hover)]'

export type ConnectionHandlers = {
  onConnect?: (endpoint: string) => void
  onRetry?: () => void
  onChangeEnvironment?: () => void
}

function runAction(action: ConnectionAction, handlers: ConnectionHandlers, endpoint?: string) {
  if (action === 'retry') handlers.onRetry?.()
  if (action === 'change_environment') handlers.onChangeEnvironment?.()
  if (action === 'connect' && endpoint) handlers.onConnect?.(endpoint)
}

function ActionButtons({
  state,
  handlers,
  extra,
}: {
  state: ConnectionUiState
  handlers: ConnectionHandlers
  extra?: ReactNode
}) {
  return (
    <div className="mt-4 flex flex-wrap justify-center gap-2">
      {extra}
      {state.action && state.action !== 'connect' ? (
        <button type="button" className={primaryButtonClass} onClick={() => runAction(state.action!, handlers)}>
          {connectionActionLabel(state.action)}
        </button>
      ) : null}
      {state.secondaryAction ? (
        <button
          type="button"
          className={secondaryButtonClass}
          onClick={() => runAction(state.secondaryAction!, handlers)}
        >
          {connectionActionLabel(state.secondaryAction)}
        </button>
      ) : null}
    </div>
  )
}

export function EnvironmentConnectForm({
  initialEndpoint = '',
  onConnect,
}: {
  initialEndpoint?: string
  onConnect: (endpoint: string) => void
}) {
  const [value, setValue] = useState(initialEndpoint)
  const [error, setError] = useState<string | null>(null)

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const endpoint = parseEnvironmentEndpoint(value)
    if (!endpoint) {
      setError('Enter an http(s) environment URL, for example http://127.0.0.1:43120.')
      return
    }
    setError(null)
    onConnect(endpoint)
  }

  return (
    <form className="mt-4 w-full max-w-md text-left" onSubmit={submit}>
      <label className="block text-ui-sm text-[var(--basis-text)]" htmlFor="environment-endpoint">
        Environment endpoint
      </label>
      <div className="mt-1.5 flex gap-2">
        <input
          id="environment-endpoint"
          name="endpoint"
          type="text"
          inputMode="url"
          autoComplete="url"
          spellCheck={false}
          placeholder="http://127.0.0.1:43120"
          className={fieldClass}
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
        <button type="submit" className={primaryButtonClass}>
          Connect
        </button>
      </div>
      {error ? (
        <p className="mt-2 text-ui-xs text-[var(--basis-text-muted)]" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  )
}

export function ConnectionScreen({
  state,
  handlers = {},
}: {
  state: ConnectionUiState
  handlers?: ConnectionHandlers
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6">
      <div className="flex w-full max-w-md flex-col items-center text-center">
        <h1 className="text-ui-base font-medium text-[var(--basis-text-strong)]">{state.title}</h1>
        <p className="mt-2 text-ui-sm leading-ui-normal text-[var(--basis-text-muted)]">
          {state.description}
        </p>
        {state.kind === 'no_environment' ? (
          <EnvironmentConnectForm initialEndpoint={state.endpoint} onConnect={(endpoint) => handlers.onConnect?.(endpoint)} />
        ) : (
          <ActionButtons state={state} handlers={handlers} />
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
  const live = state.kind === 'connecting' || state.kind === 'reconnecting'
  return (
    <div
      className={cn(
        'flex shrink-0 items-center justify-between gap-3 border-b px-5 py-2.5',
        state.kind === 'unreachable'
          ? 'border-[var(--basis-border)] bg-[var(--basis-surface)]'
          : 'border-[var(--basis-border-muted)] bg-[var(--basis-surface-elevated)]',
      )}
      role={live ? 'status' : 'alert'}
      aria-live={live ? 'polite' : 'assertive'}
    >
      <div className="min-w-0">
        <p className="text-ui-sm font-medium text-[var(--basis-text-strong)]">{state.title}</p>
        <p className="mt-0.5 text-ui-xs leading-ui-normal text-[var(--basis-text-muted)]">
          {state.description}
        </p>
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
        {state.action && state.action !== 'connect' ? (
          <button type="button" className={primaryButtonClass} onClick={() => runAction(state.action!, handlers)}>
            {connectionActionLabel(state.action)}
          </button>
        ) : null}
        {state.secondaryAction ? (
          <button
            type="button"
            className={secondaryButtonClass}
            onClick={() => runAction(state.secondaryAction!, handlers)}
          >
            {connectionActionLabel(state.secondaryAction)}
          </button>
        ) : null}
      </div>
    </div>
  )
}

export function ConnectionStatusChip({ state }: { state: ConnectionUiState }) {
  if (state.kind === 'no_environment') {
    return (
      <p className="px-4 pb-3 text-ui-xs text-[var(--basis-text-muted)]">No environment</p>
    )
  }

  const tone =
    state.kind === 'ready'
      ? 'text-[var(--basis-session-cube-ready)]'
      : state.kind === 'unauthorized' || state.kind === 'incompatible_protocol'
        ? 'text-[var(--basis-session-cube-needs)]'
        : 'text-[var(--basis-text-muted)]'

  return (
    <p className={cn('px-4 pb-3 text-ui-xs', tone)}>
      {state.kind === 'ready' ? 'Connected' : state.title}
      {state.environmentLabel ? ` · ${state.environmentLabel}` : ''}
    </p>
  )
}
