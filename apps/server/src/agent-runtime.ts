import { AgentRuntime, providers, type HostLogEntry } from '@agentpack/runtime/node'
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
export function mountAgentRuntime(log: ServerLogger): AgentRuntime {
  const runtime = new AgentRuntime(
    {
      // Protocol projection is added by the runtime bridge. Keeping the sink
      // server-local ensures raw provider events cannot reach clients before
      // that projection and persistence boundary exists.
      emitEvent: () => undefined,
      log: (entry) => logRuntimeEntry(log, entry),
    },
    providers,
  )
  return runtime
}

function logRuntimeEntry(log: ServerLogger, entry: HostLogEntry): void {
  // Provider diagnostics can contain command output. Log only the normalized
  // message until the server has a dedicated redaction policy for detail data.
  log(entry.level, `[${entry.scope}] ${entry.message}`)
}
