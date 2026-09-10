import {
  AgentRuntime,
  providers,
  type AgentRuntimeOptions,
  type HostDeps,
  type HostLogEntry,
} from '@agentpack/runtime/node'
import type { createLogger } from './logger.ts'

export type ServerLogger = ReturnType<typeof createLogger>

/**
 * Mount the provider runtime in the trusted environment process.
 *
 * Provider registrations are the same immutable registrations used by the
 * desktop. Their executable overrides, credentials, and CLI-owned config are
 * resolved by the environment process when a provider is used; none of that
 * state is added to bootstrap or socket payloads here.
 */
export function mountAgentRuntime(
  log: ServerLogger,
  emitEvent: HostDeps['emitEvent'] = () => undefined,
  desiredSessionConfig?: HostDeps['desiredSessionConfig'],
  runtimeOptions?: AgentRuntimeOptions,
): AgentRuntime {
  const runtime = new AgentRuntime(
    {
      // Only the thread bridge receives raw events. It projects the narrow
      // interruption event here; the complete privacy-safe mapping remains at
      // the dedicated protocol projection boundary.
      emitEvent,
      log: (entry) => logRuntimeEntry(log, entry),
      ...(desiredSessionConfig ? { desiredSessionConfig } : {}),
    },
    providers,
    runtimeOptions,
  )
  return runtime
}

function logRuntimeEntry(log: ServerLogger, entry: HostLogEntry): void {
  // Provider diagnostics can contain command output. Log only the normalized
  // message until the server has a dedicated redaction policy for detail data.
  log(entry.level, `[${entry.scope}] ${entry.message}`)
}
