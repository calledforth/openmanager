/**
 * Threads for the dev fixture's session pages, in the shape the environment
 * client holds them, so each fixture row opens on the page a real session in
 * that state would show: one working (a live turn with a thought, a run of
 * tools and its words so far), one waiting on a permission, one finished
 * (code, a table, a thought with text), one left running in the background,
 * one failed, and a 200-message thread
 * for measuring the list. The working one starts from the recorded live run
 * (`recorded-thread.ts`). Only for the fixture; nothing here reaches a server.
 */
import type { ContentBlock, Turn } from '@openmanager/protocol'
import type { ThreadState } from '@openmanager/environment-client'

import { RECORDED_THREAD } from './recorded-thread'

type Message = ThreadState['messages'][number]
type Tool = ThreadState['tools'][number]
type Reasoning = ThreadState['reasoning'][number]
type Ref = ThreadState['order'][number]

const iso = (ms: number) => new Date(ms).toISOString()
const text = (value: string): ContentBlock[] => [{ type: 'text', text: value }]

/** Builds one thread turn by turn, keeping the lists and the order in step. */
class ThreadBuilder {
  readonly state: ThreadState

  constructor(sessionId: string, threadId = `thread-${sessionId}`) {
    this.state = {
      thread: { threadId, sessionId },
      turns: [],
      messages: [],
      reasoning: [],
      tools: [],
      order: [],
      interactions: [],
      notices: [],
      outbox: [],
      hydration: 'ready',
      historyCursor: null,
    }
  }

  private get threadId() {
    return this.state.thread.threadId
  }

  turn(turnId: string, state: Turn['state'], startedAt: number, finishedAt?: number) {
    this.state.turns.push({
      turnId,
      threadId: this.threadId,
      state,
      startedAt: iso(startedAt),
      ...(finishedAt !== undefined ? { finishedAt: iso(finishedAt) } : {}),
    })
    return this
  }

  message(turnId: string, messageId: string, role: Message['role'], body: string) {
    this.state.messages.push({
      messageId,
      threadId: this.threadId,
      turnId,
      role,
      content: text(body),
    })
    this.place({ kind: 'message', id: messageId, turnId })
    return this
  }

  thought(turnId: string, messageId: string, body: string, phase: Reasoning['phase'] = 'stop') {
    this.state.reasoning.push({ messageId, turnId, phase, content: body ? text(body) : [] })
    this.place({ kind: 'reasoning', id: messageId, turnId })
    return this
  }

  tool(
    turnId: string,
    toolCallId: string,
    title: string,
    kind: Tool['kind'],
    status: Tool['status'],
  ) {
    this.state.tools.push({ toolCallId, turnId, title, ...(kind ? { kind } : {}), status })
    this.place({ kind: 'tool', id: toolCallId, turnId })
    return this
  }

  private place(ref: Ref) {
    this.state.order.push(ref)
  }
}

/** The recorded run, then a third turn still going: a thought, three tools (one running), words so far. */
export function workingThread(now: number): ThreadState {
  const started = now - 130_000
  const live = new ThreadBuilder('s-tool-payloads', RECORDED_THREAD.thread.threadId)
  Object.assign(live.state, structuredCloneThread(RECORDED_THREAD))
  const turn = 'turn-live'
  live
    .turn(turn, 'running', started)
    .message(
      turn,
      'live-user',
      'user',
      'Carry the tool payloads across the protocol, no diffs in chat, provider names as-is.',
    )
    .thought(turn, 'live-thought', 'The runtime already forwards rawInput and rawOutput.')
    .message(
      turn,
      'live-a1',
      'assistant',
      "The runtime already forwards `rawInput` and `rawOutput`; only `projectAgentEvent` drops them. I'll carry them through `turn_activity` and bump the protocol to v17.",
    )
    .tool(turn, 'live-t1', 'Read', 'read', 'completed')
    .tool(turn, 'live-t2', 'Read', 'read', 'completed')
    .tool(turn, 'live-t3', 'Edit', 'edit', 'completed')
    .tool(turn, 'live-t4', 'Bash', 'execute', 'in_progress')
    .thought(turn, 'live-thought-2', '', 'delta')
  return live.state
}

function structuredCloneThread(thread: ThreadState): Partial<ThreadState> {
  return {
    turns: [...thread.turns],
    messages: [...thread.messages],
    reasoning: [...thread.reasoning],
    tools: [...thread.tools],
    order: [...thread.order],
  }
}

/** A turn stopped on a permission for a shell command, asked two minutes ago. */
export function permissionThread(now: number): ThreadState {
  const b = new ThreadBuilder('s-settings-redesign')
  const turn = 'turn-p1'
  b.turn(turn, 'waiting', now - 240_000)
    .message(
      turn,
      'p-user',
      'user',
      'Make Add Project show the default path already chosen, then let me edit it.',
    )
    .message(
      turn,
      'p-a1',
      'assistant',
      "I'll read the default from the environment settings and prefill the field. The browser opens at that path.",
    )
    .tool(turn, 'p-t1', 'Read', 'read', 'completed')
    .tool(turn, 'p-t2', 'Edit', 'edit', 'completed')
    .tool(turn, 'p-t3', 'pnpm --filter @openmanager/web test', 'execute', 'pending')
  b.state.interactions.push({
    sessionId: 's-settings-redesign',
    threadId: b.state.thread.threadId,
    turnId: turn,
    interaction: {
      kind: 'permission',
      interactionId: 'perm-1',
      lifecycle: {
        state: 'pending',
        createdAt: iso(now - 125_000),
        resolvedAt: null,
        resolvedByClientId: null,
      },
      toolCall: {
        toolCallId: 'p-t3',
        title: 'pnpm --filter @openmanager/web test',
        kind: 'execute',
      },
      options: [
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'always', name: 'Always', kind: 'allow_always' },
        { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
      ],
    },
  })
  return b.state
}

const PRICING_ANSWER = `Three tiers, each a step up in seats and support:

| Tier | Price | Seats |
| --- | --- | --- |
| Starter | $19/mo | 3 |
| Team | $49/mo | 10 |
| Scale | $129/mo | 50 |

The price table renders from one object so the copy and the checkout never disagree:

\`\`\`ts
// One source for the page and the checkout.
export const TIERS = [
  { id: 'starter', price: 19, seats: 3 },
  { id: 'team', price: 49, seats: 10 },
  { id: 'scale', price: 129, seats: 50 },
] as const
\`\`\`

> Lead with the outcome, not the feature list.`

/** A finished turn: a thought with text, a run of tools, then an answer with code and a table. */
export function doneThread(now: number): ThreadState {
  const b = new ThreadBuilder('s-pricing')
  const turn = 'turn-d1'
  b.turn(turn, 'completed', now - 4_214_000, now - 4_200_000)
    .message(turn, 'd-user', 'user', 'Write the pricing page copy, three tiers.')
    .thought(
      turn,
      'd-thought',
      'Three tiers read best when each one names who it is for. Keep the numbers in one table and one source object.',
    )
    .tool(turn, 'd-t1', 'Read', 'read', 'completed')
    .tool(turn, 'd-t2', 'Grep', 'search', 'completed')
    .tool(turn, 'd-t3', 'Edit', 'edit', 'completed')
    .message(turn, 'd-a1', 'assistant', PRICING_ANSWER)
  return b.state
}

/** A finished turn that left work running: the session is in the background since it ended. */
export function backgroundThread(now: number): ThreadState {
  const b = new ThreadBuilder('s-mcp-server')
  const turn = 'turn-b1'
  b.turn(turn, 'completed', now - 262_000, now - 240_000)
    .message(turn, 'b-user', 'user', 'Start the dev server and keep the tests watching.')
    .tool(turn, 'b-t1', 'Bash', 'execute', 'completed')
    .tool(turn, 'b-t2', 'Bash', 'execute', 'completed')
    .message(
      turn,
      'b-a1',
      'assistant',
      'The dev server is up on `:5174` and `vitest --watch` is running. Both keep going in the background.',
    )
  return b.state
}

/** A turn the provider gave up on, with the environment's words for why. */
export function failedThread(now: number): ThreadState {
  const b = new ThreadBuilder('s-sync-f2')
  const turn = 'turn-f1'
  b.turn(turn, 'failed', now - 10_838_000, now - 10_800_000)
    .message(turn, 'f-user', 'user', 'Run the convergence harness against the fixture replay.')
    .tool(turn, 'f-t1', 'Bash', 'execute', 'completed')
    .tool(turn, 'f-t2', 'Bash', 'execute', 'failed')
  // The turn carries its failure, as the environment's snapshot does.
  b.state.turns[b.state.turns.length - 1]!.failure = {
    reason: 'provider_process_exited',
    message: 'The provider process exited (code 1).',
  }
  b.state.notices.push({ turnId: turn, message: 'Retried once after the provider was overloaded.' })
  return b.state
}

/** The session id of the long fixture thread, for the list's measurements. */
export const LONG_THREAD_SESSION_ID = 's-long-thread'

const PARAGRAPH =
  'The list keeps each row as the object it was, so a token in the last turn re-renders that row alone. Older turns stay mounted only while they are near the screen.'

/** 100 settled turns (200 messages): prose, inline code, a fence every few turns, a tool run each. */
export function longThread(now: number, turns = 100): ThreadState {
  const b = new ThreadBuilder(LONG_THREAD_SESSION_ID)
  for (let index = 0; index < turns; index += 1) {
    const turn = `turn-${index}`
    const started = now - (turns - index) * 120_000
    b.turn(turn, 'completed', started, started + 9_000 + (index % 7) * 1_000)
      .message(
        turn,
        `u-${index}`,
        'user',
        `Step ${index + 1}: tighten the list and say what changed.`,
      )
      .tool(turn, `t-${index}-a`, 'Read', 'read', 'completed')
      .tool(turn, `t-${index}-b`, 'Edit', 'edit', 'completed')
      .message(
        turn,
        `a-${index}`,
        'assistant',
        index % 4 === 0
          ? `Changed \`SessionThread\` (turn ${index + 1}).\n\n\`\`\`ts\nconst rows = useMemo(() => [...messages].reverse(), [messages])\n\`\`\`\n\n${PARAGRAPH}`
          : `Turn ${index + 1}: ${PARAGRAPH}\n\n- kept the keys stable\n- memoised the row`,
      )
  }
  return b.state
}
