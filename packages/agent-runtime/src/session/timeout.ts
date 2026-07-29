import type { ProviderId } from '@agentpack/contract'

/** An RPC that never answered. Distinguishable from an agent-reported error so
 * a caller can tell "the CLI said no" from "the CLI said nothing". */
export class RpcTimeoutError extends Error {
  readonly name = 'RpcTimeoutError'
  constructor(
    readonly providerId: ProviderId,
    readonly method: string,
    readonly timeoutMs: number,
  ) {
    super(`${providerId} did not answer ${method} within ${timeoutMs}ms`)
  }
}

/** Reject after `ms`, leaving the original promise to settle on its own.
 *
 * Deliberately does not cancel the underlying work: ACP has no way to withdraw
 * an in-flight request, and there is nothing to gain from pretending
 * otherwise. What bounds the damage is what the *caller* does on rejection —
 * a handshake step tears the process down (`start_failed`), and a live-session
 * control RPC leaves the applied-state cache untouched, so a late response
 * cannot retroactively be believed and the next attempt simply retries. */
export function withTimeout<T>(work: Promise<T>, ms: number, error: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(error()), ms)
    timer.unref?.()
    work.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (cause: unknown) => {
        clearTimeout(timer)
        reject(cause instanceof Error ? cause : new Error(String(cause)))
      },
    )
  })
}
