import type {
  AgentInfo,
  AuthMethod,
  AvailableCommand,
  ModelListing,
  PromptCapabilities,
  ProviderId,
  ProviderSessionInfo,
} from '@agentpack/contract'
import type { BackendEvent } from '../backends/Backend.js'
import type { ThreadId } from './lifecycle.js'

/** A throwaway process for provider-level questions that must not touch a live
 * session: `session/list`, health probes, model catalogs.
 *
 * A session runtime cannot answer these — it exists per thread, and the callers
 * (`AgentHost.ensureProvider`, `AgentHost.refreshSessionTitles`) have no thread
 * at all, only a workspace. They currently fake one with `desktop-bootstrap:*`
 * / `session-metadata:*` pseudo-thread ids against the shared per-provider
 * process. With per-session processes there is no shared process to borrow, so
 * these get their own short-lived one.
 *
 * Running probes out-of-process is also what makes continuous health checking
 * safe: on Cursor every model/config write is process-global, so probing
 * inside a live session process would change the model a user's turn runs on. */
export interface ProbeRuntime {
  readonly providerId: ProviderId
  /** Spawn, `initialize`, and `authenticate` if the agent offers a method. */
  probe(): Promise<ProbeResult>
  /** Paginated `session/list`. Requires `probe()` to have reported
   * `sessionListAdvertised`. Cheap: ~55ms per page. */
  listSessions(cwd: string): Promise<ProviderSessionInfo[]>
  /** Model catalog, where the provider exposes one. Costs a `session/new`
   * (~3.5s on Cursor) in this throwaway process, never in a live one. */
  listModels(cwd: string): Promise<ModelListing>
  /** Always call; the process leaks otherwise. */
  dispose(): Promise<void>
}

export type ProbeResult = {
  agentInfo?: AgentInfo
  protocolVersion?: string
  authMethods: AuthMethod[]
  /** True when no auth method was offered, or the offered one succeeded. */
  authenticated: boolean
  /** Populated when authentication was attempted and refused. */
  authError?: string
  promptCapabilities?: PromptCapabilities
  sessionListAdvertised: boolean
  loadSessionAdvertised: boolean
  /** Slash commands the provider knows about before any session exists.
   *
   * Absent over ACP, where `available_commands_update` only ever arrives as a
   * `session/update` on a live session — so an ACP probe leaves this undefined
   * rather than reporting an empty list, which would read as "this agent has
   * no commands". A provider whose catalog is static and readable at handshake
   * time fills it in, and the bootstrap surfaces it without waiting for a
   * session. */
  commands?: AvailableCommand[]
}

/** What a probe needs beyond a provider and a directory.
 *
 * All optional, and every one of them is about *observability* rather than the
 * probe's answer: the health monitor asks for none of them, while the desktop
 * bootstrap wants the handshake's lifecycle events stamped with the
 * pseudo-thread it is bootstrapping. Keeping them out of the required
 * arguments is what lets a fake factory in a test implement `create(providerId,
 * cwd)` and still satisfy this interface. */
export type ProbeRuntimeOptions = {
  /** Pseudo-thread the probe's lifecycle events are stamped with. Only used
   * when `onEvent` is supplied. */
  threadId?: ThreadId
  workspaceId?: string
  /** When present the probe emits the same `process_spawned` / `initialized` /
   * `authenticated` / `auth_required` events the shared per-provider process
   * used to emit on `AgentRuntime.start`. The renderer learns agent info and
   * prompt capabilities from `initialized`, so the bootstrap path supplies
   * this; repeat metadata probes stay silent to avoid event spam. */
  onEvent?: (event: BackendEvent) => void
}

export interface ProbeRuntimeFactory {
  create(providerId: ProviderId, cwd: string, options?: ProbeRuntimeOptions): ProbeRuntime
}
