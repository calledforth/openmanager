import type * as acp from '@agentclientprotocol/sdk'
import type { ProviderId } from '@agentpack/contract'
import type { ProcessExit, TerminationRequest } from './lifecycle.js'

/** The ACP transport, split out from the runtime interfaces it used to share a
 * file with. `SessionRuntime` and `ProbeRuntime` describe what a runtime *is*,
 * for any provider; everything here is specific to talking JSON-RPC to a child
 * process over stdio, and a provider driven through an SDK has no use for it. */
export type AcpConnectionSpec = {
  providerId: ProviderId
  command: string
  args: readonly string[]
  cwd: string
  env: Readonly<Record<string, string>>
  /** Handlers for agent-initiated traffic, installed before the first byte. */
  client: acp.Client
  /** Reject the spawn if the child has not produced a connection in time. */
  spawnTimeoutMs: number
  /** Default grace between SIGTERM and SIGKILL in `terminate`, when the
   * `TerminationRequest` does not name its own. */
  terminateGraceMs: number
}

/** One live child process plus its ACP connection. Owns nothing above the
 * transport: no sessions, no config state, no event fan-out. */
export interface AcpConnection {
  readonly connection: acp.ClientSideConnection
  readonly pid: number | undefined
  /** Resolves when the child is gone, whatever the reason. Watching this is
   * how a dead process is noticed *without* waiting for the next RPC to fail. */
  readonly exited: Promise<ProcessExit>
  /** SIGTERM, then SIGKILL after `graceMs`. Idempotent. */
  terminate(request: TerminationRequest): Promise<ProcessExit>
}

export interface AcpConnectionFactory {
  connect(spec: AcpConnectionSpec): Promise<AcpConnection>
}
