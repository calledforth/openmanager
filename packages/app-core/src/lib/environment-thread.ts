import type { ContentBlock, Message, Turn } from '@openmanager/protocol'
import {
  selectActiveThread,
  shallowEqualArray,
  type EnvironmentClient,
  type EnvironmentState,
  type ReasoningEntry,
  type ThreadState,
  type ToolState,
} from '@openmanager/environment-client'
import type { LocalStreamingMessage, MessagePart } from './streaming-messages-store'
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
 * tools → text. Exact interleaving arrives with replay (CAL-71).
 */
export interface ProjectedMessage {
  message: UIMessage
  content: MessageContentSnapshot
  streaming: LocalStreamingMessage
}

interface TurnProjection {
  deps: unknown[]
  entries: ProjectedMessage[]
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

export function isTurnSettled(turn: Turn): boolean {
  return turn.state === 'completed' || turn.state === 'interrupted' || turn.state === 'failed'
}

export function contentText(blocks: readonly ContentBlock[]): string {
  return blocks
    .map((block) => {
      if (block.type === 'text') return block.text
      if (block.type === 'resource') return block.text ?? ''
      return ''
    })
    .join('')
}

function imageParts(message: Message): MessagePart[] {
  return message.content.flatMap((block, index) =>
    block.type === 'image'
      ? [
          {
            type: 'image',
            id: `${message.messageId}:image:${index}`,
            url: `data:${block.mimeType};base64,${block.data}`,
            name: `image-${index + 1}`,
          },
        ]
      : [],
  )
}

function reasoningPart(entry: ReasoningEntry): MessagePart {
  const text = contentText(entry.content)
  return {
    type: 'reasoning',
    id: `reasoning:${entry.messageId}`,
    text,
    ...(entry.tokens !== undefined ? { tokens: entry.tokens } : {}),
    // The environment carries no wall-clock timing; a settled block shows the
    // plain "Thought" label, an open one keeps shimmering with the turn.
    ...(entry.phase === 'stop' ? { time: { start: 0, end: 0 } } : {}),
  }
}

function toolStatus(status: ToolState['status']): string {
  if (status === 'in_progress') return 'running'
  if (status === 'failed') return 'error'
  return status ?? 'pending'
}

function toolPart(tool: ToolState): MessagePart {
  return {
    type: 'tool',
    id: tool.toolCallId,
    callID: tool.toolCallId,
    tool: tool.title ?? tool.kind ?? 'tool',
    ...(tool.kind ? { kind: tool.kind } : {}),
    state: { status: toolStatus(tool.status) },
  }
}

function projectTurn(
  thread: ThreadState,
  turn: Turn,
  sequenceStart: number,
  previous: TurnProjection | undefined,
): TurnProjection {
  const messages = thread.messages.filter((message) => message.turnId === turn.turnId)
  const reasoning = thread.reasoning.filter((entry) => entry.turnId === turn.turnId)
  const tools = thread.tools.filter((tool) => tool.turnId === turn.turnId)
  const failure = thread.failures.find((item) => item.turnId === turn.turnId)
  const deps = [turn, sequenceStart, failure, ...messages, ...reasoning, ...tools]
  if (previous && shallowEqualArray(previous.deps, deps)) return previous

  const entries: ProjectedMessage[] = []
  let sequenceNum = sequenceStart
  const settled = isTurnSettled(turn)

  for (const message of messages) {
    if (message.role !== 'user') continue
    const content = contentText(message.content)
    const parts = imageParts(message)
    entries.push({
      message: { externalId: message.messageId, role: 'user', isFinal: true, sequenceNum },
      content: { content, ...(parts.length ? { parts } : {}) },
      streaming: { content, parts, hasCompleteHistory: true },
    })
    sequenceNum += 1
  }

  const assistantMessages = messages.filter((message) => message.role === 'assistant')
  const parts: MessagePart[] = [
    ...reasoning.map(reasoningPart),
    ...tools.map(toolPart),
    ...assistantMessages.map((message) => ({
      type: 'text',
      id: message.messageId,
      text: contentText(message.content),
    })),
    ...(failure
      ? [{ type: 'text', id: `failure:${turn.turnId}`, text: `Turn failed: ${failure.message}` }]
      : []),
  ]
  if (parts.length > 0 || !settled) {
    const content = assistantMessages.map((message) => contentText(message.content)).join('')
    entries.push({
      message: {
        externalId: assistantMessages[0]?.messageId ?? `turn:${turn.turnId}:assistant`,
        role: 'assistant',
        isFinal: settled,
        sequenceNum,
      },
      content: { content, parts },
      streaming: { content, parts, hasCompleteHistory: true },
    })
  }

  return { deps, entries }
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
