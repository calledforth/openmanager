export { AgentRuntime } from './core/AgentRuntime.js'
export type {
  AgentRuntimeOptions,
  ProviderCatalogSnapshot,
  RuntimeRoute,
  RuntimeSessionArgs,
} from './core/AgentRuntime.js'
export { PermissionBroker, PERMISSION_TIMEOUT_MS } from './core/PermissionBroker.js'
export { InteractionBroker, INTERACTION_TIMEOUT_MS } from './core/InteractionBroker.js'
export type {
  InteractionKind,
  InteractionResolution,
  InteractionSettlement,
} from './core/InteractionBroker.js'
export { AuthRequiredError, CapabilityMissingError } from './core/errors.js'
export {
  PROVIDER_HEALTH_PROBE_TIMEOUT_MS,
  PROVIDER_HEALTH_REFRESH_INTERVAL_MS,
  ProbeTimeoutError,
  ProviderHealthMonitor,
} from './core/ProviderHealthMonitor.js'
export type {
  ProviderHealthMonitorDeps,
  ProviderHealthRefreshReason,
  ProviderRuntimeCensus,
} from './core/ProviderHealthMonitor.js'
export { SessionReaper } from './core/SessionReaper.js'
export type { SessionReaperDeps } from './core/SessionReaper.js'
export type {
  BackendEvent,
  BackendEventListener,
  BackendRoute,
  SessionResult,
} from './backends/Backend.js'
export { ExtensionRegistry } from './backends/acp/extensions.js'
export { parseAcpFormElicitation } from './backends/acp/elicitation.js'
export type { AcpFormQuestionAdapter } from './backends/acp/elicitation.js'
export type {
  ExtensionHandlers,
  ExtensionNotificationHandler,
  ExtensionRequestHandler,
} from './backends/acp/extensions.js'
// The session-scoped runtime: one child process per thread, no shared
// per-provider process. See docs/session-runtime-design.md.
export {
  AcpProbeRuntimeFactoryImpl,
  AcpProbeRuntimeImpl,
  AcpSessionRuntimeFactory,
  AcpSessionRuntimeImpl,
  AppliedConfigCache,
  ChildProcessConnection,
  ChildProcessConnectionFactory,
  configValueAdvertised,
  configValueMatches,
  DEFAULT_RUNTIME_TIMEOUTS,
  isRuntimeAlive,
  MAX_SESSION_RUNTIMES,
  ProviderProbeRuntimeFactory,
  ProviderSessionRuntimeFactory,
  RpcTimeoutError,
  SESSION_IDLE_TIMEOUT_MS,
  SESSION_REAP_INTERVAL_MS,
  SessionRuntimeRegistryImpl,
  SHUTDOWN_BUDGET_MS,
  withTimeout,
} from './session/index.js'
export type {
  AcpConnection,
  AcpConnectionFactory,
  AcpConnectionSpec,
  AcpProbeDeps,
  AcpProbeSpec,
  ActiveTurn,
  AppliedSessionState,
  AppliedStateSource,
  ConfigApplyDecision,
  ConfigApplyPlan,
  DesiredSessionConfig,
  ManagedSessionRuntime,
  ManagedSessionRuntimeFactory,
  ProbeResult,
  ProbeRuntime,
  ProbeRuntimeFactory,
  ProbeRuntimeOptions,
  ProcessExit,
  ProviderProbeRuntimeFactoryDeps,
  ProviderSessionRuntimeFactoryDeps,
  RuntimeTimeouts,
  SessionResumeRecord,
  SessionRuntime,
  SessionRuntimeDeps,
  SessionRuntimeEntry,
  SessionRuntimeExit,
  SessionRuntimeFactory,
  SessionRuntimePhase,
  SessionRuntimeRegistry,
  SessionRuntimeRegistryDeps,
  SessionRuntimeSpec,
  SessionRuntimeStopReason,
  StartedEntry,
  TerminableChild,
  TerminationRequest,
  ThreadId,
} from './session/index.js'
export { cursor, opencode, providers, requireAcpConfig } from './providers/index.js'
export type {
  AcpProviderConfig,
  ClaudeProviderConfig,
  ProviderConfig,
  ProviderConfigBase,
} from './providers/index.js'
export type { HostDeps, HostLogEntry } from './host.js'
