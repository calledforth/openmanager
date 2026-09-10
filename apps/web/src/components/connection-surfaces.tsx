import { useState, type FormEvent, type ReactNode } from 'react'
import {
  connectionActionLabel,
  type ConnectionAction,
  type ConnectionUiState,
} from '../lib/connection-state'
import {
  parseEnvironmentCredential,
  parseEnvironmentEndpoint,
  type StoredEnvironment,
} from '../lib/environment-store'
import { cn } from '../lib/utils'

const fieldClass =
  'w-full rounded-md border border-[var(--basis-border)] bg-[var(--basis-surface)] px-3 py-1.5 text-ui-sm text-[var(--basis-text)] outline-none focus-visible:border-[var(--basis-border-strong)]'
const primaryButtonClass =
  'rounded-md bg-[var(--basis-action-bg)] px-3 py-1.5 text-ui-sm text-[var(--basis-action-fg)] hover:bg-[var(--basis-action-hover)] disabled:opacity-50'
const secondaryButtonClass =
  'rounded-md border border-[var(--basis-border)] bg-[var(--basis-surface)] px-3 py-1.5 text-ui-sm text-[var(--basis-text)] hover:bg-[var(--basis-surface-hover)]'

export type ConnectionHandlers = {
  onConnect?: (endpoint: string, credential?: string) => void
  onRetry?: () => void
  onChangeEnvironment?: () => void
  onSelectEnvironment?: (environmentId: string) => void
  onRemoveEnvironment?: (environmentId: string) => void
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
  submitLabel = 'Connect',
}: {
  initialEndpoint?: string
  onConnect: (endpoint: string, credential: string) => void
  submitLabel?: string
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
    <form className="mt-4 w-full max-w-md text-left" onSubmit={submit}>
      <label className="block text-ui-sm text-[var(--basis-text)]" htmlFor="environment-endpoint">
        Environment endpoint
      </label>
      <input
        id="environment-endpoint"
        name="endpoint"
        type="text"
        inputMode="url"
        autoComplete="url"
        spellCheck={false}
        placeholder="http://127.0.0.1:43120"
        className={cn(fieldClass, 'mt-1.5')}
        value={endpointValue}
        onChange={(event) => setEndpointValue(event.target.value)}
      />
      <label className="mt-3 block text-ui-sm text-[var(--basis-text)]" htmlFor="environment-credential">
        Client token
      </label>
      <p className="mt-0.5 text-ui-xs text-[var(--basis-text-muted)]">
        Optional. Stored with the environment, not with a particular URL.
      </p>
      <input
        id="environment-credential"
        name="credential"
        type="password"
        autoComplete="off"
        spellCheck={false}
        placeholder="Paste client-token"
        className={cn(fieldClass, 'mt-1.5')}
        value={credentialValue}
        onChange={(event) => setCredentialValue(event.target.value)}
      />
      <button type="submit" className={cn(primaryButtonClass, 'mt-3')}>
        {submitLabel}
      </button>
      {error ? (
        <p className="mt-2 text-ui-xs text-[var(--basis-text-muted)]" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  )
}

export function EnvironmentList({
  environments,
  selectedId,
  onSelect,
  onRemove,
}: {
  environments: StoredEnvironment[]
  selectedId: string | null
  onSelect?: (environmentId: string) => void
  onRemove?: (environmentId: string) => void
}) {
  if (environments.length === 0) return null

  return (
    <ul className="mt-4 w-full max-w-md space-y-2 text-left" aria-label="Saved environments">
      {environments.map((environment) => {
        const selected = environment.environmentId === selectedId
        return (
          <li
            key={environment.environmentId}
            className={cn(
              'rounded-md border px-3 py-2.5',
              selected
                ? 'border-[var(--basis-border-strong)] bg-[var(--basis-surface-elevated)]'
                : 'border-[var(--basis-border)] bg-[var(--basis-surface)]',
            )}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-ui-sm font-medium text-[var(--basis-text-strong)]">
                  {environment.label}
                  {selected ? ' · Selected' : ''}
                </p>
                <p className="mt-0.5 font-mono text-ui-xs text-[var(--basis-text-faint)]">
                  {environment.environmentId}
                </p>
                <p className="mt-1 font-mono text-ui-xs text-[var(--basis-text-muted)]">
                  {environment.endpoints.join(' · ')}
                </p>
                <p className="mt-1 text-ui-xs text-[var(--basis-text-muted)]">
                  {environment.credential ? 'Client token saved' : 'No client token'}
                </p>
              </div>
              <div className="flex shrink-0 flex-col gap-1.5">
                {onSelect && !selected ? (
                  <button
                    type="button"
                    className={secondaryButtonClass}
                    onClick={() => onSelect(environment.environmentId)}
                  >
                    Select
                  </button>
                ) : null}
                {onRemove ? (
                  <button
                    type="button"
                    className={secondaryButtonClass}
                    onClick={() => onRemove(environment.environmentId)}
                  >
                    Remove
                  </button>
                ) : null}
              </div>
            </div>
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
}: {
  state: ConnectionUiState
  handlers?: ConnectionHandlers
  environments?: StoredEnvironment[]
  selectedId?: string | null
}) {
  const choosingSaved = state.kind === 'no_environment' && environments.length > 0
  const title = choosingSaved ? 'Select an environment' : state.title
  const description = choosingSaved
    ? 'Choose a saved environment or add another endpoint. A second URL for the same environment ID updates the existing record.'
    : state.description

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6">
      <div className="flex w-full max-w-md flex-col items-center text-center">
        <h1 className="text-ui-base font-medium text-[var(--basis-text-strong)]">{title}</h1>
        <p className="mt-2 text-ui-sm leading-ui-normal text-[var(--basis-text-muted)]">
          {description}
        </p>
        {state.kind === 'no_environment' ? (
          <>
            <EnvironmentList
              environments={environments}
              selectedId={selectedId}
              onSelect={handlers.onSelectEnvironment}
              onRemove={handlers.onRemoveEnvironment}
            />
            <EnvironmentConnectForm
              initialEndpoint={state.endpoint}
              onConnect={(endpoint, credential) => handlers.onConnect?.(endpoint, credential)}
            />
          </>
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
