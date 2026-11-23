import { describeTurnOperation, parseTurnOperation } from '@agentpack/contract'

/**
 * How the user rows nobody typed as a prompt read, pure so web's
 * `TurnOriginRows` and the phone say the same words.
 */

/** The summary line of a "subagents finished" notice: its first line, without a trailing colon. */
export function subagentsNoticeLine(content: string): { title: string; more: boolean } {
  // The environment wraps the notice in a tag the agent reads; it says nothing to a person.
  const lines = content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !/^<\/?[a-z-]+>$/.test(line))
  const first = (lines[0] ?? 'Subagents finished').replace(/[:.]\s*$/, '')
  return { title: first, more: lines.length > 1 }
}

/**
 * The command that ran a provider operation (`/review`, `/compact`), in a few
 * words: what ran, what it looked at, and the command as typed.
 */
export function operationPromptView(
  content: string,
  origin: 'review' | 'compact',
): { label: string; detail?: string; command: string } {
  const operation = parseTurnOperation(content)
  const { label, detail } = operation
    ? describeTurnOperation(operation)
    : { label: origin === 'review' ? 'Code review' : 'Compact the conversation', detail: undefined }
  return {
    label,
    ...(detail ? { detail } : {}),
    command: content.trim().split(/\s+/)[0] ?? '',
  }
}
