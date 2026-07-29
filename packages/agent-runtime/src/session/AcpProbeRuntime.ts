import type {
  AgentInfo,
  AuthMethod,
  ModelListing,
  PromptCapabilities,
  ProviderId,
  ProviderSessionInfo,
} from '@agentpack/contract'

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
export interface AcpProbeRuntime {
  readonly providerId: ProviderId
  /** Spawn, `initialize`, and `authenticate` if the agent offers a method. */
  probe(): Promise<AcpProbeResult>
  /** Paginated `session/list`. Requires `probe()` to have reported
   * `sessionListAdvertised`. Cheap: ~55ms per page. */
  listSessions(cwd: string): Promise<ProviderSessionInfo[]>
  /** Model catalog, where the provider exposes one. Costs a `session/new`
   * (~3.5s on Cursor) in this throwaway process, never in a live one. */
  listModels(cwd: string): Promise<ModelListing>
  /** Always call; the process leaks otherwise. */
  dispose(): Promise<void>
}

export type AcpProbeResult = {
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
}

export interface AcpProbeRuntimeFactory {
  create(providerId: ProviderId, cwd: string): AcpProbeRuntime
}
