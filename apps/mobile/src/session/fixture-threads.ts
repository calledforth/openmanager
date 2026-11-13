/**
 * Threads for the dev fixture's session pages, in the shape the environment
 * client holds them, so each fixture row opens on the page a real session in
 * that state would show: one working (a live turn with a thought, a run of
 * tools and its words so far), one waiting on a permission, one finished
 * (code, a table, a thought with text), one left running in the background,
 * one failed, one of pictures sent and returned (one, two, three, four, ten
 * at a time), and a 200-message thread for measuring the list. The working
 * one starts from the recorded live run (`recorded-thread.ts`). Only for the
 * fixture; nothing here reaches a server.
 */
import type { ContentBlock, Turn } from '@openmanager/protocol'
import type { ThreadState } from '@openmanager/environment-client'

import { fixturePng } from './fixture-images'
import { RECORDED_THREAD } from './recorded-thread'

type Message = ThreadState['messages'][number]
type Tool = ThreadState['tools'][number]
type Reasoning = ThreadState['reasoning'][number]
type Ref = ThreadState['order'][number]
type Notice = ThreadState['notices'][number]

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
      liveNotices: [],
      outbox: [],
      hydration: 'ready',
      listing: {},
      queue: { items: [], pausedBy: null },
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

  message(
    turnId: string,
    messageId: string,
    role: Message['role'],
    body: string,
    pictures: readonly ContentBlock[] = [],
  ) {
    this.state.messages.push({
      messageId,
      threadId: this.threadId,
      turnId,
      role,
      content: [...(body ? text(body) : []), ...pictures],
    })
    this.place({ kind: 'message', id: messageId, turnId })
    return this
  }

  thought(turnId: string, messageId: string, body: string, phase: Reasoning['phase'] = 'stop') {
    this.state.reasoning.push({ messageId, turnId, phase, content: body ? text(body) : [] })
    this.place({ kind: 'reasoning', id: messageId, turnId })
    return this
  }

  /** A tool call; `extra` carries what a v21 environment sends with it (name, input, paths, counts, times). */
  tool(
    turnId: string,
    toolCallId: string,
    title: string,
    kind: Tool['kind'],
    status: Tool['status'],
    extra: Omit<Partial<Tool>, 'toolCallId' | 'turnId' | 'title' | 'kind' | 'status'> = {},
  ) {
    this.state.tools.push({
      toolCallId,
      turnId,
      title,
      ...(kind ? { kind } : {}),
      status,
      ...extra,
    })
    this.place({ kind: 'tool', id: toolCallId, turnId })
    return this
  }

  /** A durable notice, in the place it happened. */
  notice(turnId: string, noticeId: string, fields: Omit<Notice, 'noticeId' | 'turnId'>) {
    this.state.notices.push({ noticeId, turnId, ...fields })
    this.place({ kind: 'notice', id: noticeId, turnId })
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
    .tool(turn, 'live-t1', 'Read', 'read', 'completed', {
      toolName: 'Read',
      input: { file_path: 'packages/agent-runtime/src/protocol/projectAgentEvent.ts' },
      locations: [{ path: 'packages/agent-runtime/src/protocol/projectAgentEvent.ts' }],
    })
    .tool(turn, 'live-t2', 'Read', 'read', 'completed', {
      toolName: 'Read',
      input: { file_path: 'packages/protocol/src/domains.ts' },
      locations: [{ path: 'packages/protocol/src/domains.ts' }],
    })
    .tool(turn, 'live-t3', 'Edit', 'edit', 'completed', {
      toolName: 'Edit',
      input: { file_path: 'packages/protocol/src/domains.ts' },
      locations: [{ path: 'packages/protocol/src/domains.ts' }],
      lineChanges: { added: 24, removed: 3 },
    })
    .tool(turn, 'live-t4', 'Bash', 'execute', 'in_progress', {
      toolName: 'Bash',
      input: { command: 'pnpm --filter @openmanager/protocol test' },
      output: ' RUN  v4.1.0 packages/protocol\n\n ✓ tests/tool-state.test.ts (12 tests)\n',
      startedAt: iso(now - 4_000),
    })
    .thought(turn, 'live-thought-2', '', 'delta')
  // A steer waiting on the running command, and a message queued behind it.
  live.state.queue = {
    items: [
      {
        queueItemId: 'fixture-steer',
        text: 'Skip the web tests, the protocol suite is enough for now.',
        settings: {},
        delivery: 'steering',
        createdAt: iso(now - 20_000),
      },
      {
        queueItemId: 'fixture-queued',
        text: 'Then update the protocol README with the new fields.',
        settings: {},
        delivery: 'queued',
        createdAt: iso(now - 12_000),
      },
    ],
    pausedBy: null,
  }
  live.state.steeredQueueIds = ['fixture-steer']
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
    .tool(turn, 'p-t3', 'pnpm --filter @openmanager/web test', 'execute', 'pending', {
      toolName: 'Bash',
      input: { command: 'pnpm --filter @openmanager/web test' },
    })
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
    .tool(turn, 'd-t1', 'Read', 'read', 'completed', {
      toolName: 'Read',
      input: { file_path: 'apps/site/src/pages/pricing.tsx' },
      locations: [{ path: 'apps/site/src/pages/pricing.tsx' }],
    })
    .tool(turn, 'd-t2', 'Grep', 'search', 'completed', {
      toolName: 'Grep',
      input: { pattern: 'TIERS', path: 'apps/site/src' },
    })
    .tool(turn, 'd-t3', 'Edit', 'edit', 'completed', {
      toolName: 'Edit',
      input: { file_path: 'apps/site/src/pages/pricing.tsx' },
      locations: [{ path: 'apps/site/src/pages/pricing.tsx' }],
      lineChanges: { added: 41, removed: 12 },
    })
    .notice(turn, 'd-n1', {
      kind: 'compacted',
      message: 'Conversation compacted',
      compaction: { trigger: 'auto', tokensBefore: 182_400, tokensAfter: 21_300 },
    })
    .message(turn, 'd-a1', 'assistant', PRICING_ANSWER)
  return b.state
}

/** A finished turn that left work running: the session is in the background since it ended. */
export function backgroundThread(now: number): ThreadState {
  const b = new ThreadBuilder('s-mcp-server')
  const turn = 'turn-b1'
  b.turn(turn, 'completed', now - 262_000, now - 240_000)
    .message(turn, 'b-user', 'user', 'Start the dev server and keep the tests watching.')
    .tool(turn, 'b-t1', 'Bash', 'execute', 'completed', {
      toolName: 'Bash',
      input: { command: 'pnpm dev --port 5174', run_in_background: true },
    })
    .tool(turn, 'b-t2', 'Bash', 'execute', 'completed', {
      toolName: 'Bash',
      input: { command: 'pnpm vitest --watch', run_in_background: true },
    })
    .message(
      turn,
      'b-a1',
      'assistant',
      'The dev server is up on `:5174` and `vitest --watch` is running. Both keep going in the background.',
    )
  return b.state
}

/**
 * A turn the provider gave up on: a call that failed, one the user declined,
 * a notice that a limit is close, and the typed failure the turn ends on.
 */
export function failedThread(now: number): ThreadState {
  const b = new ThreadBuilder('s-sync-f2')
  const turn = 'turn-f1'
  const started = now - 10_838_000
  b.turn(turn, 'failed', started, now - 10_800_000)
    .message(turn, 'f-user', 'user', 'Run the convergence harness against the fixture replay.')
    .tool(turn, 'f-t1', 'Bash', 'execute', 'completed', {
      toolName: 'Bash',
      input: { command: 'pnpm --filter @openmanager/server build' },
      outputBytes: 1_840,
      startedAt: iso(started + 2_000),
      finishedAt: iso(started + 14_500),
    })
    .tool(turn, 'f-t2', 'Bash', 'execute', 'failed', {
      toolName: 'Bash',
      input: { command: 'node --test tests/convergence/scenarios.test.ts' },
      outputBytes: 6_210,
      startedAt: iso(started + 15_000),
      finishedAt: iso(started + 21_000),
    })
    .tool(turn, 'f-t3', 'Bash', 'execute', 'declined', {
      toolName: 'Bash',
      input: { command: 'rm -rf apps/server/.data' },
    })
    .notice(turn, 'f-n1', {
      kind: 'usage_warning',
      message: "You've used 90% of your weekly limit",
      resetsAt: iso(now + 2 * 86_400_000),
    })
  // The turn carries its failure, as the environment's snapshot does.
  b.state.turns[b.state.turns.length - 1]!.failure = {
    reason: 'overloaded',
    message: 'The provider is overloaded right now.',
    action: 'retry',
    detail: 'API Error: 529 {"type":"overloaded_error","message":"Overloaded"}',
  }
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

/** The pictures' shapes, in turn: wide, tall, square, wide again. */
const SHAPES: ReadonlyArray<readonly [number, number]> = [
  [180, 120],
  [120, 180],
  [150, 150],
  [200, 120],
]
const drawn = new Map<number, ContentBlock>()

/** The `n`th fixture picture, drawn once, as an inline image block. */
function picture(n: number): ContentBlock {
  let block = drawn.get(n)
  if (!block) {
    const [width, height] = SHAPES[n % SHAPES.length]!
    block = {
      type: 'image',
      mimeType: 'image/png',
      data: fixturePng(width, height, (n * 47) % 360, n),
    }
    drawn.set(n, block)
  }
  return block
}

const pictures = (from: number, count: number) =>
  Array.from({ length: count }, (_, i) => picture(from + i))

/**
 * Three settled turns of pictures: references sent four, one and two at a
 * time; variants returned one, three and ten at a time.
 */
export function imagesThread(now: number): ThreadState {
  const b = new ThreadBuilder('s-soul-id')
  const t1 = 'turn-i1'
  b.turn(t1, 'completed', now - 1_900_000, now - 1_840_000)
    .message(
      t1,
      'i-user-1',
      'user',
      'Match this reference — the soul ID avatar grid.',
      pictures(0, 4),
    )
    .thought(
      t1,
      'i-thought-1',
      'Four references: a consistent palette, soft discs, one band across.',
    )
    .message(
      t1,
      'i-a1',
      'assistant',
      'First pass at the avatar, from the four references.',
      pictures(4, 1),
    )
  const t2 = 'turn-i2'
  b.turn(t2, 'completed', now - 1_500_000, now - 1_430_000)
    .message(t2, 'i-user-2', 'user', 'Closer to this crop.', pictures(5, 1))
    .message(t2, 'i-a2', 'assistant', 'Three variants at that crop.', pictures(6, 3))
  const t3 = 'turn-i3'
  b.turn(t3, 'completed', now - 900_000, now - 780_000)
    .message(t3, 'i-user-3', 'user', 'Both of these, then give me the full set.', pictures(9, 2))
    .message(t3, 'i-a3', 'assistant', 'All ten variants from the two picks.', pictures(11, 10))
  return b.state
}
