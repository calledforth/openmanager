import { useState, type FormEvent, type ReactNode } from 'react'
import { Button } from '@openmanager/app-core/components/fluid/ui/button'
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

// Tend's connect field: borderless, sits on the hover tint and darkens on focus.
const fieldClass =
  'h-9 w-full rounded-lg bg-hover/70 px-3 text-[15px] outline-none transition-colors duration-100 placeholder:text-faint focus:bg-hover'

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

export function EnvironmentConnectForm({
  initialEndpoint = '',
  onConnect,
  submitLabel = 'Connect',
  className,
}: {
  initialEndpoint?: string
  onConnect: (endpoint: string, credential: string) => void
  submitLabel?: string
  className?: string
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
        The token is optional. Leave it blank on localhost to request the local owner token. It
        is stored with the environment, not with a particular URL.
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
    <ul className="mt-4 flex w-full flex-col gap-2 text-left" aria-label="Saved environments">
      {environments.map((environment) => {
        const selected = environment.environmentId === selectedId
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
                <p className="mt-1 font-mono text-[12px] text-muted-foreground">
                  {environment.endpoints.join(' · ')}
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

  // Tend's connect page: a narrow column, vertically centred and lifted a
  // little above the middle.
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-auto px-6 pb-24">
      <div className="flex w-full max-w-[340px] flex-col">
        <h1 className="text-[22px] font-semibold leading-[1.3] tracking-[-0.015em]">{title}</h1>
        <p className="mt-1 text-[14px] text-muted-foreground">{description}</p>
        {state.kind === 'no_environment' ? (
          <>
            <EnvironmentList
              environments={environments}
              selectedId={selectedId}
              onSelect={handlers.onSelectEnvironment}
              onRemove={handlers.onRemoveEnvironment}
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
      <div className="min-w-0">
        <p className="text-ui-sm font-medium text-[var(--basis-text-strong)]">{state.title}</p>
        <p className="mt-0.5 text-ui-xs leading-ui-normal text-[var(--basis-text-muted)]">
          {state.description}
        </p>
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
