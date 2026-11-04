import { createContext, useContext, useMemo } from 'react'

/**
 * What a host that keeps several environments apart says about the open one,
 * beyond what its client knows. Hosts with one environment serve nothing, and
 * everything here reads as it always did.
 */
export interface EnvironmentAvailability {
  /** The name failures here go by. Absent with only one environment to mean. */
  name?: string
  /** Why nothing can be sent right now, or null while it can. */
  sendBlockedReason: string | null
}

export const EnvironmentAvailabilityContext = createContext<EnvironmentAvailability | null>(null)

export function useEnvironmentAvailability(): EnvironmentAvailability | null {
  return useContext(EnvironmentAvailabilityContext)
}

const asIs = (message: string) => message

/** Puts the open environment's name on a failure, where there is more than one to mean. */
export function useFailureNamer(): (message: string) => string {
  const name = useEnvironmentAvailability()?.name
  return useMemo(() => (name ? (message: string) => `${name}: ${message}` : asIs), [name])
}

/**
 * What an answer or a send throws when the host holds it. Nothing went out,
 * and the reason is already on screen, so it isn't a failure to report.
 */
export class SendHeldError extends Error {
  readonly held = true
}

export function isSendHeld(error: unknown): boolean {
  return error instanceof SendHeldError
}

/** What a failed answer says: its message, named for the environment when there are several. */
export function failureText(error: unknown, name: (message: string) => string): string | null {
  if (isSendHeld(error)) return null
  return name(error instanceof Error ? error.message : String(error))
}
