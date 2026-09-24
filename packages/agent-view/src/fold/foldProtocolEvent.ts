import type {
  ContentBlock,
  Interaction,
  Message,
  ProofEvent,
  Thread,
  Turn,
  TurnFailureReason,
} from '@openmanager/protocol'

export interface ReasoningEntry {
  messageId: string
  turnId: string
  phase: 'start' | 'delta' | 'stop'
  content: ContentBlock[]
  tokens?: number
}

export type ToolState = Extract<ProofEvent, { name: 'tool.updated' }>['payload']

export interface PendingInteraction {
  sessionId: string
  threadId: string
  turnId: string
  interaction: Interaction
}

export interface TurnFailure {
  turnId: string
  reason: TurnFailureReason
  message: string
}

/**
 * One thing that took its place in a turn's transcript: a message, a reasoning
 * block or a tool call, named by the id it is stored under.
 */
export interface ActivityRef {
  kind: 'message' | 'reasoning' | 'tool'
  id: string
  turnId: string
}

/** Snapshot-compatible inputs; transports retain ownership of cursors and deduplication. */
export interface ProtocolThreadView {
  thread: Thread
  turns: Turn[]
  messages: Message[]
  reasoning: ReasoningEntry[]
  tools: ToolState[]
  /**
   * Messages, reasoning blocks and tool calls in the order they first appeared.
   * The three lists above are keyed by id and say nothing about how their
   * entries interleave; this is what a transcript walks to show a thought, the
   * tools it led to, and the text that followed, in that order.
   */
  order: ActivityRef[]
  interactions: PendingInteraction[]
  failures: TurnFailure[]
}

/** Append `ref` unless the same entry is already placed. */
export function placeActivity(order: ActivityRef[], ref: ActivityRef): ActivityRef[] {
  return order.some((item) => item.kind === ref.kind && item.id === ref.id)
    ? order
    : [...order, ref]
}

export function isTurnSettled(turn: Turn): boolean {
  return turn.state === 'completed' || turn.state === 'interrupted' || turn.state === 'failed'
}

/**
 * Settle every open reasoning block in `turnId`. ACP providers stream thinking
 * as bare deltas and never say when a block ends, so a block is closed by the
 * next non-thought event in its turn: an assistant message chunk, a tool
 * update, or the end of the turn. Providers that do frame their blocks (Claude
 * Code) send an explicit `stop` first, which this leaves untouched.
 */
function closeReasoning(reasoning: ReasoningEntry[], turnId: string): ReasoningEntry[] {
  if (!reasoning.some((entry) => entry.turnId === turnId && entry.phase !== 'stop'))
    return reasoning
  return reasoning.map((entry) =>
    entry.turnId === turnId && entry.phase !== 'stop' ? { ...entry, phase: 'stop' } : entry,
  )
}

function upsert<T>(items: T[], id: (item: T) => string, next: T): T[] {
  const index = items.findIndex((item) => id(item) === id(next))
  if (index === -1) return [...items, next]
  const copy = items.slice()
  copy[index] = next
  return copy
}

function mergeContent(existing: ContentBlock[], delta: ContentBlock): ContentBlock[] {
  const last = existing.at(-1)
  return last?.type === 'text' && delta.type === 'text'
    ? [...existing.slice(0, -1), { type: 'text', text: last.text + delta.text }]
    : [...existing, delta]
}

/** Fold durable protocol parts and terminal outcomes without an IPC overlay. */
export function foldProtocolEvent<T extends ProtocolThreadView>(current: T, event: ProofEvent): T {
  if (
    event.scope.type !== 'thread' ||
    event.scope.threadId !== current.thread.threadId ||
    event.scope.sessionId !== current.thread.sessionId
  )
    return current
  if (!('turnId' in event.payload)) return current
  const turnId = event.payload.turnId
  const turn = current.turns.find((item) => item.turnId === turnId)
  // Terminal outcomes are immutable, including when late callbacks arrive.
  if (turn && isTurnSettled(turn)) return current

  switch (event.name) {
    case 'turn.completed':
    case 'turn.interrupted':
    case 'turn.failed': {
      const state =
        event.name === 'turn.completed'
          ? 'completed'
          : event.name === 'turn.interrupted'
            ? 'interrupted'
            : 'failed'
      return {
        ...current,
        turns: upsert(current.turns, (item) => item.turnId, {
          ...turn,
          turnId,
          threadId: current.thread.threadId,
          state,
        }),
        reasoning: closeReasoning(current.reasoning, turnId),
        interactions: current.interactions.filter((item) => item.turnId !== turnId),
        failures:
          event.name === 'turn.failed'
            ? upsert(current.failures, (item) => item.turnId, {
                turnId,
                reason: event.payload.reason,
                message: event.payload.message,
              })
            : current.failures,
      }
    }
    case 'message.delta': {
      const existing = current.messages.find(
        (message) => message.messageId === event.payload.messageId,
      )
      const message: Message = existing
        ? { ...existing, content: mergeContent(existing.content, event.payload.content) }
        : {
            messageId: event.payload.messageId,
            threadId: current.thread.threadId,
            turnId,
            role: event.payload.role,
            content: [event.payload.content],
          }
      return {
        ...current,
        messages: upsert(current.messages, (item) => item.messageId, message),
        order: existing
          ? current.order
          : placeActivity(current.order, { kind: 'message', id: message.messageId, turnId }),
        // Text following a thought is what ends the thought for ACP providers.
        reasoning:
          message.role === 'assistant'
            ? closeReasoning(current.reasoning, turnId)
            : current.reasoning,
      }
    }
    case 'message.reasoning': {
      const existing = current.reasoning.find(
        (entry) => entry.messageId === event.payload.messageId,
      )
      return {
        ...current,
        reasoning: upsert(current.reasoning, (entry) => entry.messageId, {
          messageId: event.payload.messageId,
          turnId,
          phase: event.payload.phase,
          content:
            event.payload.content === undefined
              ? (existing?.content ?? [])
              : mergeContent(existing?.content ?? [], event.payload.content),
          tokens: event.payload.tokens ?? existing?.tokens,
        }),
        order: existing
          ? current.order
          : placeActivity(current.order, {
              kind: 'reasoning',
              id: event.payload.messageId,
              turnId,
            }),
      }
    }
    case 'tool.updated': {
      const existing = current.tools.find((tool) => tool.toolCallId === event.payload.toolCallId)
      return {
        ...current,
        tools: upsert(current.tools, (tool) => tool.toolCallId, {
          ...existing,
          ...event.payload,
        }),
        order: existing
          ? current.order
          : placeActivity(current.order, { kind: 'tool', id: event.payload.toolCallId, turnId }),
        reasoning: closeReasoning(current.reasoning, turnId),
      }
    }
    default:
      return current
  }
}
