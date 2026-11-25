import { SpawnTimeoutError } from '../session/ChildProcessLifecycle.js'
import { CodexRpcTimeoutError } from '../session/codex/CodexRpcPeer.js'
import { RpcTimeoutError } from '../session/timeout.js'
import { SessionUnknownError } from './errors.js'

/** Errors that say "this start" went wrong, not "this provider" does. By
 * name as well as by class, so an error that crossed a bundle boundary (two
 * copies of the class) is still recognised. */
const NOT_PROVIDER_WIDE = new Set([
  // The CLI was too slow to spawn, or to answer `initialize`, `session/new`
  // or `session/load`, within its budget. On a machine under load that is
  // slowness, and the next start may well succeed. A CLI that truly hangs
  // still turns the provider unhealthy: the health probe times out too.
  'SpawnTimeoutError',
  'RpcTimeoutError',
  'CodexRpcTimeoutError',
  // One thread's stored session is gone from the agent. Every other thread
  // is unaffected.
  'SessionUnknownError',
])

/** Whether a session runtime's failed `start()` is evidence that the provider
 * itself does not work. Anything not recognised as start-specific counts: a
 * CLI that exits during its handshake, refuses its credentials or answers
 * with an error is broken for every thread, not just this one. */
export function startFailureIsProviderWide(error: unknown): boolean {
  if (
    error instanceof SpawnTimeoutError ||
    error instanceof RpcTimeoutError ||
    error instanceof CodexRpcTimeoutError ||
    error instanceof SessionUnknownError
  ) {
    return false
  }
  if (error instanceof Error && NOT_PROVIDER_WIDE.has(error.name)) return false
  return true
}
