import type { ProviderFailureInfo } from '@openmanager/shared/contracts/provider-health'

/** SIGKILL as a signal, or as the 128+9 exit code a shell or `wsl.exe` hands
 * back for a child it lost that way. Nothing in openmanager sends SIGKILL to a
 * session it has not been asked to stop (those exits are expected, and never
 * reach here), so on Linux and WSL it is almost always the kernel's
 * out-of-memory killer. */
function killedOutright(failure: ProviderFailureInfo): boolean {
  return failure.signal === 'SIGKILL' || failure.exitCode === 137
}

/** One sentence on why a provider is unhealthy, for people who were refused
 * because of it. Says how long ago, because the state lasts until something
 * newer clears it, and an old reason reads differently from a fresh one. */
export function describeProviderFailure(
  failure: ProviderFailureInfo,
  now: number = Date.now(),
): string {
  const when = ago(failure.at, now)
  switch (failure.kind) {
    case 'crash': {
      if (killedOutright(failure)) {
        return `A session process was killed (SIGKILL) ${when}, most likely by the out-of-memory killer: the machine ran out of RAM.`
      }
      const how =
        failure.signal != null
          ? `signal ${failure.signal}`
          : `exit code ${failure.exitCode ?? 'unknown'}`
      return `A session process crashed ${when} (${how}).`
    }
    case 'start_failed':
      return `A session failed to start ${when}: ${failure.message}`
    case 'probe_timeout':
      return `The health check did not answer in time ${when}; the machine may be overloaded.`
    case 'probe_failed':
      return `The health check failed ${when}: ${failure.message}`
    case 'auth':
      return `The CLI refused its credentials ${when}: ${failure.message}`
    default:
      return failure.kind satisfies never
  }
}

function ago(at: string, now: number): string {
  const then = Date.parse(at)
  if (Number.isNaN(then)) return 'recently'
  const seconds = Math.max(0, Math.round((now - then) / 1000))
  if (seconds < 60) return seconds <= 1 ? 'just now' : `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ago`
}
