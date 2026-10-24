import type {
  ContentBlock,
  Interaction,
  Message,
  ProofEvent,
  Thread,
  Turn,
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

function upsert<T>(items: T[], id: (item: T) => string, next: T): T[] {
  const index = items.findIndex((item) => id(item) === id(next))
  if (index === -1) return [...items, next]
  const copy = items.slice()
  copy[index] = next
  return copy
}

function tokensOf(held: number | undefined, next: number | undefined): { tokens?: number } {
  if (next === undefined) return held === undefined ? {} : { tokens: held }
  return { tokens: Math.max(held ?? 0, next) }
}

function mergeContent(existing: ContentBlock[], delta: ContentBlock): ContentBlock[] {
  const last = existing.at(-1)
  return last?.type === 'text' && delta.type === 'text'
    ? [...existing.slice(0, -1), { type: 'text', text: last.text + delta.text }]
    : [...existing, delta]
}

/**
 * Whether a turn-scoped event of this thread names a turn the view does not
 * hold. Every subscription starts with a replay or a snapshot, so that is a
 * protocol error: the caller recovers the scope instead of inventing the
 * turn (docs/sync-foundations.md §3.5). `turn.started` introduces its turn,
 * and a transient notice is never worth a recovery.
 */
export function namesUnknownTurn(current: ProtocolThreadView, event: ProofEvent): boolean {
  if (event.scope.type !== 'thread' || event.scope.threadId !== current.thread.threadId)
    return false
  if (event.name === 'turn.started' || event.name === 'turn.notice') return false
  if (!('turnId' in event.payload)) return false
  const { turnId } = event.payload
  return !current.turns.some((turn) => turn.turnId === turnId)
}

/**
 * Fold one durable thread event: each event changes only what it names (I2).
 * The server is the only author: it closes a turn's tools, thoughts and
 * requests with their own events before the turn's end, and sends a finished
 * turn nothing but those closes, so this applies what it receives and decides
 * nothing of its own. An event for a turn the view does not hold changes
 * nothing (see `namesUnknownTurn`).
 */
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
  if (!turn) return current

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
          state,
          // The terminal event's time is when the work stopped.
          finishedAt: event.timestamp,
          ...(event.name === 'turn.failed'
            ? { failure: { reason: event.payload.reason, message: event.payload.message } }
            : {}),
          ...(event.name === 'turn.interrupted' ? { interruptedBy: event.payload.reason } : {}),
        }),
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
          // As the projector keeps it: the token estimate only ever grows.
          ...tokensOf(existing?.tokens, event.payload.tokens),
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
      }
    }
    default:
      return current
  }
}
