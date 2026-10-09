import type { ProviderProblem } from '@agentpack/contract'

/** A provider error typed from its message alone, for providers that give
 * nothing structured (the ACP agents answer a failed prompt with a JSON-RPC
 * error and prose). Only unmistakable phrasings are mapped; anything else is
 * left untyped, so the turn fails as a plain provider error, as it did before.
 * Compacting is never offered from here: whether a provider can is its own
 * business, and nothing in an error message says. */
export function problemFromMessage(message: string): ProviderProblem | undefined {
  if (
    /prompt is too long|context (?:window|length) (?:exceeded|limit)|maximum context length/i.test(
      message,
    )
  )
    return { code: 'context_window_exceeded' }
  if (
    /usage limit|out of (?:usage|credits)|quota exceeded|insufficient (?:credits|quota)/i.test(
      message,
    )
  )
    return { code: 'usage_limit' }
  if (/rate.?limit|too many requests/i.test(message)) return { code: 'rate_limited' }
  if (/overloaded/i.test(message)) return { code: 'overloaded' }
  return undefined
}
