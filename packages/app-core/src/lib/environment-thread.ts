import { isTurnSettled } from '@agentpack/view'
export { isTurnSettled } from '@agentpack/view'
import type { ContentBlock, Message, Turn } from '@openmanager/protocol'
import {
  selectActiveThread,
  shallowEqualArray,
  type EnvironmentClient,
  type EnvironmentState,
  type OutboxEntry,
  type ReasoningEntry,
  type ThreadState,
  type ToolState,
} from '@openmanager/environment-client'
import type { LocalStreamingMessage, MessagePart } from './streaming-messages-store'
import type { TurnRuntimeMetadata } from '../components/parts/turn-work-group'
import type {
  MessageContentSnapshot,
  MessageContentStore,
  StreamingMessageSource,
  UIMessage,
} from '../providers/active-thread-provider'

/**
 * Projection of a normalized environment thread into what the chat timeline
 * renders: one row per user prompt, one row per assistant turn, each with the
 * persisted body the row reads through `messageContentStore` and the live
 * snapshot it reads through the streaming store.
 *
 * The environment keeps reasoning and tool calls per turn rather than
 * interleaved with the text, so an assistant row orders them reasoning →
 * tools → text. Live tokens arrive as protocol events on the environment
 * client; there is no IPC overlay and no Convex `stream_chunks` store.
 */
export interface ProjectedMessage {
  message: UIMessage
  content: MessageContentSnapshot
  streaming: LocalStreamingMessage
}

interface TurnProjection {
  deps: unknown[]
  entries: ProjectedMessage[]
  /**
   * The message each user row was built from. A streamed token rebuilds its
   * turn, but the prompt that started the turn has not changed, so its row is
   * reused and the bubble on screen does not re-render.
   */
  userSources: Map<string, Message>
}

export interface ThreadProjection {
  thread: ThreadState | null
  messages: UIMessage[]
  byId: Map<string, ProjectedMessage>
  /** Per-turn memo so a token in one turn does not rebuild every other row. */
  turns: Map<string, TurnProjection>
}

export const EMPTY_THREAD_PROJECTION: ThreadProjection = {
  thread: null,
  messages: [],
  byId: new Map(),
  turns: new Map(),
}

export function contentText(blocks: readonly ContentBlock[]): string {
  return blocks
    .map((block) => {
      if (block.type === 'text') return block.text
      if (block.type === 'resource_link') return block.uri
      if (block.type === 'resource') return block.text ?? block.uri ?? ''
      return ''
    })
    .join('')
}

function imageParts(message: Message, sessionId: string): MessagePart[] {
  return message.content.flatMap((block, index): MessagePart[] => {
    if (block.type === 'image') {
      return [
        {
          type: 'image',
          id: `${message.messageId}:image:${index}`,
          url: `data:${block.mimeType};base64,${block.data}`,
          name: `image-${index + 1}`,
        },
      ]
    }
    // The durable message only names stored bytes; the row reads them through
    // the environment client when it is on screen.
    if (block.type === 'artifact' && block.mimeType.startsWith('image/')) {
      return [
        {
          type: 'image',
          id: `${message.messageId}:artifact:${block.artifactId}`,
          artifact: { sessionId, artifactId: block.artifactId },
          name: block.name,
          // What the agent produced is answer content, not part of its work trace.
          ...(message.role === 'assistant' ? { generated: true } : {}),
        },
      ]
    }
    return []
  })
}

/**
 * Parts by the state object they were built from. The store replaces only the
 * entry an event touched, so every other thought, tool and message of a live
 * turn is the object it was on the last event, and gets the part it had: a row
 * that compares parts by identity then skips everything that did not change.
 */
const reasoningParts = new WeakMap<ReasoningEntry, { settled: boolean; part: MessagePart }>()
const toolParts = new WeakMap<ToolState, MessagePart>()
const textPartsByMessage = new WeakMap<Message, MessagePart[]>()
/** The row of a send still waiting on the environment, kept while it stays where it is. */
const outboxRows = new WeakMap<OutboxEntry, UIMessage>()

function reasoningPart(entry: ReasoningEntry, settled: boolean): MessagePart {
  const cached = reasoningParts.get(entry)
  if (cached && cached.settled === settled) return cached.part
  const part = buildReasoningPart(entry, settled)
  reasoningParts.set(entry, { settled, part })
  return part
}

function buildReasoningPart(entry: ReasoningEntry, settled: boolean): MessagePart {
  const text = contentText(entry.content)
  return {
    type: 'reasoning',
    id: `reasoning:${entry.messageId}`,
    text,
    ...(entry.tokens !== undefined ? { tokens: entry.tokens } : {}),
    // The environment carries no wall-clock timing; a settled block shows the
    // plain "Thought" label, an open one keeps shimmering with the turn.
    ...(settled || entry.phase === 'stop' ? { time: { start: 0, end: 0 } } : {}),
  }
}

function toolStatus(status: ToolState['status']): string {
  if (status === 'in_progress') return 'running'
  if (status === 'failed') return 'error'
  return status ?? 'pending'
}

function toolPart(tool: ToolState): MessagePart {
  let part = toolParts.get(tool)
  if (!part) {
    part = {
      type: 'tool',
      id: tool.toolCallId,
      callID: tool.toolCallId,
      tool: tool.title ?? tool.kind ?? 'tool',
      ...(tool.kind ? { kind: tool.kind } : {}),
      state: { status: toolStatus(tool.status) },
    }
    toolParts.set(tool, part)
  }
  return part
}

/** A message belongs to one thread for good, so its session never changes under it. */
function textParts(message: Message, sessionId: string): MessagePart[] {
  let parts = textPartsByMessage.get(message)
  if (!parts) {
    parts = [
      { type: 'text', id: message.messageId, text: contentText(message.content) },
      ...imageParts(message, sessionId),
    ]
    textPartsByMessage.set(message, parts)
  }
  return parts
}

const EMPTY: readonly never[] = []

/**
 * One of a thread's lists, split by turn. The store keeps each list whole, and
 * an event replaces only the list it touches, so the split is kept per list:
 * a streamed token re-splits the messages and leaves the tools, thoughts and
 * order as they were, where filtering per turn walked all four for every turn.
 */
const byTurnCache = new WeakMap<readonly { turnId: string }[], Map<string, unknown[]>>()

function byTurn<T extends { turnId: string }>(items: readonly T[], turnId: string): readonly T[] {
  let split = byTurnCache.get(items) as Map<string, T[]> | undefined
  if (!split) {
    split = new Map()
    for (const item of items) {
      const bucket = split.get(item.turnId)
      if (bucket) bucket.push(item)
      else split.set(item.turnId, [item])
    }
    byTurnCache.set(items, split)
  }
  return split.get(turnId) ?? EMPTY
}

/** The row's identity is what the timeline lists; keep it while it says the same thing. */
function rowMessage(previous: TurnProjection | undefined, next: UIMessage): UIMessage {
  const held = previous?.entries.find(
    (entry) => entry.message.externalId === next.externalId,
  )?.message
  return held &&
    held.role === next.role &&
    held.isFinal === next.isFinal &&
    held.sequenceNum === next.sequenceNum
    ? held
    : next
}

function projectTurn(
  thread: ThreadState,
  turn: Turn,
  sequenceStart: number,
  previous: TurnProjection | undefined,
): TurnProjection {
  const messages = byTurn(thread.messages, turn.turnId)
  const reasoning = byTurn(thread.reasoning, turn.turnId)
  const tools = byTurn(thread.tools, turn.turnId)
  const order = byTurn(thread.order, turn.turnId)
  const failure = thread.failures.find((item) => item.turnId === turn.turnId)
  const deps = [turn, sequenceStart, failure, ...messages, ...reasoning, ...tools, ...order]
  if (previous && shallowEqualArray(previous.deps, deps)) return previous

  const entries: ProjectedMessage[] = []
  const userSources = new Map<string, Message>()
  let sequenceNum = sequenceStart
  const settled = isTurnSettled(turn)

  for (const message of messages) {
    if (message.role !== 'user') continue
    userSources.set(message.messageId, message)
    // Linear, but over the handful of rows one turn produces.
    const reused =
      previous?.userSources.get(message.messageId) === message
        ? previous?.entries.find((entry) => entry.message.externalId === message.messageId)
        : undefined
    if (reused && reused.message.sequenceNum === sequenceNum) {
      entries.push(reused)
      sequenceNum += 1
      continue
    }
    const content = contentText(message.content)
    const parts = imageParts(message, thread.thread.sessionId)
    entries.push({
      message: { externalId: message.messageId, role: 'user', isFinal: true, sequenceNum },
      content: { content, ...(parts.length ? { parts } : {}) },
      streaming: { content, parts, hasCompleteHistory: true },
    })
    sequenceNum += 1
  }

  const assistantMessages = messages.filter((message) => message.role === 'assistant')
  const sessionId = thread.thread.sessionId
  // A long turn places hundreds of entries; looking each one up by scanning
  // would make every streamed event quadratic in the turn's length.
  const reasoningById = new Map(reasoning.map((entry) => [entry.messageId, entry]))
  const toolsById = new Map(tools.map((tool) => [tool.toolCallId, tool]))
  const assistantById = new Map(assistantMessages.map((message) => [message.messageId, message]))
  // The transcript follows the order things happened in: a thought, the tools
  // it led to, the text that followed. Anything the order does not place (a
  // page from an environment that keeps no order) falls back to the grouped
  // layout, reasoning first and text last, so the answer still ends the turn.
  const placed = new Set<string>()
  const parts: MessagePart[] = []
  for (const ref of order) {
    const key = `${ref.kind}:${ref.id}`
    if (placed.has(key)) continue
    let placedParts: MessagePart[] | undefined
    if (ref.kind === 'reasoning') {
      const entry = reasoningById.get(ref.id)
      placedParts = entry ? [reasoningPart(entry, settled)] : undefined
    } else if (ref.kind === 'tool') {
      const tool = toolsById.get(ref.id)
      placedParts = tool ? [toolPart(tool)] : undefined
    } else {
      const message = assistantById.get(ref.id)
      placedParts = message ? textParts(message, sessionId) : undefined
    }
    if (!placedParts) continue
    placed.add(key)
    parts.push(...placedParts)
  }
  parts.push(
    ...reasoning
      .filter((entry) => !placed.has(`reasoning:${entry.messageId}`))
      .map((entry) => reasoningPart(entry, settled)),
    ...tools.filter((tool) => !placed.has(`tool:${tool.toolCallId}`)).map(toolPart),
    ...assistantMessages
      .filter((message) => !placed.has(`message:${message.messageId}`))
      .flatMap((message) => textParts(message, sessionId)),
    ...(failure
      ? [{ type: 'text', id: `failure:${turn.turnId}`, text: `Turn failed: ${failure.message}` }]
      : []),
  )
  if (parts.length > 0 || !settled) {
    // Each run is its own message; the plain-text fallback keeps them as paragraphs.
    const content = assistantMessages
      .map((message) => contentText(message.content))
      .filter((text) => text.length > 0)
      .join('\n\n')
    const runtime = turnRuntime(turn)
    entries.push({
      // Tokens change the row's body, which it reads from the stores; the row
      // the timeline lists is the same row, so the list does not change.
      message: rowMessage(previous, {
        externalId: assistantMessages[0]?.messageId ?? `turn:${turn.turnId}:assistant`,
        role: 'assistant',
        isFinal: settled,
        sequenceNum,
      }),
      content: { content, parts, ...(runtime ? { runtime } : {}) },
      streaming: { content, parts, hasCompleteHistory: true },
    })
  }

  return { deps, entries, userSources }
}

/**
 * When the turn ran, for the "Worked for 45s" label on its settled row. An
 * environment that reports no timing gets the plain label.
 */
function turnRuntime(turn: Turn): TurnRuntimeMetadata | undefined {
  const startedAt = turn.startedAt ? Date.parse(turn.startedAt) : Number.NaN
  const completedAt = turn.finishedAt ? Date.parse(turn.finishedAt) : Number.NaN
  const timed = Number.isFinite(startedAt) && Number.isFinite(completedAt)
  const unprompted = turn.origin === 'background'
  if (!timed && !unprompted) return undefined
  return { ...(timed ? { startedAt, completedAt } : {}), ...(unprompted ? { unprompted } : {}) }
}

/** Project `thread`, reusing rows from `previous` whose inputs are unchanged. */
export function projectThread(
  thread: ThreadState | null,
  previous: ThreadProjection = EMPTY_THREAD_PROJECTION,
): ThreadProjection {
  if (thread === previous.thread) return previous
  if (!thread) return { ...EMPTY_THREAD_PROJECTION, turns: previous.turns }

  const turns = new Map<string, TurnProjection>()
  const byId = new Map<string, ProjectedMessage>()
  const messages: UIMessage[] = []
  let sequence = 0
  for (const turn of thread.turns) {
    const projection = projectTurn(thread, turn, sequence, previous.turns.get(turn.turnId))
    turns.set(turn.turnId, projection)
    for (const entry of projection.entries) {
      byId.set(entry.message.externalId, entry)
      messages.push(entry.message)
    }
    sequence += projection.entries.length
  }

  // Sends the environment has not confirmed yet close the timeline: they are
  // always newer than every turn it told us about.
  for (const entry of thread.outbox) {
    const held = outboxRows.get(entry)
    if (held?.sequenceNum === sequence) {
      messages.push(held)
    } else {
      const row: UIMessage = {
        externalId: `send:${entry.commandId}`,
        role: 'user',
        isFinal: true,
        sequenceNum: sequence,
        optimisticContent: entry.text,
        ...(entry.artifactIds?.length
          ? {
              optimisticAttachments: entry.artifactIds.map((artifactId, index) => ({
                id: artifactId,
                name: `image-${index + 1}`,
                artifact: { sessionId: thread.thread.sessionId, artifactId },
              })),
            }
          : {}),
        isOptimistic: true,
        commandId: entry.commandId,
        ...(entry.error ? { sendError: entry.error } : {}),
      }
      outboxRows.set(entry, row)
      messages.push(row)
    }
    sequence += 1
  }

  return {
    thread,
    messages: shallowEqualArray(previous.messages, messages) ? previous.messages : messages,
    byId,
    turns,
  }
}

export interface EnvironmentThreadStores {
  streamingStore: StreamingMessageSource
  messageContentStore: MessageContentStore
  /** The projection of the client's active thread for its current state. */
  current: () => ThreadProjection
  /** Selector-shaped accessor for `useEnvironmentState`. */
  select: (state: EnvironmentState) => ThreadProjection
}

/**
 * Bind the projection to a client as the two external stores the active
 * thread contract expects. Both recompute lazily from the client's state and
 * notify on every store update; row identity is preserved for unchanged
 * turns so subscribers of untouched messages re-render nothing.
 */
export function createEnvironmentThreadStores(client: EnvironmentClient): EnvironmentThreadStores {
  let lastState: EnvironmentState | null = null
  let projection = EMPTY_THREAD_PROJECTION

  const select = (state: EnvironmentState) => {
    if (state !== lastState) {
      projection = projectThread(selectActiveThread(state), projection)
      lastState = state
    }
    return projection
  }
  const current = () => select(client.getState())

  return {
    select,
    current,
    streamingStore: {
      subscribe: (_messageId, listener) => client.subscribe(listener),
      get: (messageId) => current().byId.get(messageId)?.streaming,
      ensureHydrated: () => undefined,
    },
    messageContentStore: {
      subscribe: (_messageId, listener) => client.subscribe(listener),
      get: (messageId) => current().byId.get(messageId)?.content ?? null,
    },
  }
}
