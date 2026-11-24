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
import type { ContentBlock, Subagent, Turn } from '@openmanager/protocol'
import type { BackgroundTask, ThreadState } from '@openmanager/environment-client'
import type { LineageSession } from '@openmanager/app-core/logic'

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

  /** `origin`: who began a turn nobody prompted (delegated, subagents) or the operation it ran. */
  turn(
    turnId: string,
    state: Turn['state'],
    startedAt: number,
    finishedAt?: number,
    origin?: Turn['origin'],
  ) {
    this.state.turns.push({
      turnId,
      threadId: this.threadId,
      state,
      startedAt: iso(startedAt),
      ...(finishedAt !== undefined ? { finishedAt: iso(finishedAt) } : {}),
      ...(origin ? { origin } : {}),
    })
    return this
  }

  /** `phase`: what an assistant message is, as Codex marks every one. */
  message(
    turnId: string,
    messageId: string,
    role: Message['role'],
    body: string,
    pictures: readonly ContentBlock[] = [],
    phase?: Message['phase'],
  ) {
    this.state.messages.push({
      messageId,
      threadId: this.threadId,
      turnId,
      role,
      content: [...(body ? text(body) : []), ...pictures],
      ...(phase ? { phase } : {}),
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

  /**
   * A subagent the turn started, placed where its call was: a native one's
   * runtime claims the call, so no tool row stands there, only the card.
   */
  subagent(
    turnId: string,
    subagentId: string,
    fields: Pick<Subagent, 'title' | 'status' | 'startedAt'> & Partial<Subagent>,
  ) {
    const toolCallId = fields.toolCallId ?? `call-${subagentId}`
    this.state.subagents = [
      ...(this.state.subagents ?? []),
      {
        subagentId,
        parentSessionId: this.state.thread.sessionId,
        turnId,
        toolCallId,
        depth: 1,
        origin: 'native',
        providerId: 'claude',
        agentType: 'Explore',
        background: false,
        promptable: false,
        stoppable: false,
        stats: {},
        updatedAt: fields.startedAt,
        ...fields,
      },
    ]
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
    .subagent(turn, 'live-sub', {
      title: 'Contract tests for turn_activity',
      agentType: 'general-purpose',
      status: 'running',
      startedAt: iso(now - 48_000),
      childSessionId: 's-tool-payloads-tests',
      activity: 'Running the agent-runtime protocol tests',
      stoppable: true,
    })
    .tool(turn, 'live-t4', 'Bash', 'execute', 'in_progress', {
      toolName: 'Bash',
      input: { command: 'pnpm --filter @openmanager/protocol test' },
      output: ' RUN  v4.1.0 packages/protocol\n\n ✓ tests/tool-state.test.ts (12 tests)\n',
      startedAt: iso(now - 4_000),
    })
    .thought(
      turn,
      'live-thought-2',
      'The suite is green so far. If the tool-state tests pass, the payload shape holds end to end, and the only thing left is the web row reading `rawInput` instead of the title. Worth checking whether Cursor sends',
      'delta',
    )
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
    .subagent(turn, 'd-sub1', {
      title: 'Competitor pricing pages',
      status: 'completed',
      startedAt: iso(now - 4_210_000),
      finishedAt: iso(now - 4_204_000),
      stats: { durationMs: 6_000, toolCalls: 9 },
    })
    .subagent(turn, 'd-sub2', {
      title: 'Plan names that read well',
      agentType: 'general-purpose',
      status: 'completed',
      startedAt: iso(now - 4_210_000),
      finishedAt: iso(now - 4_205_000),
      stats: { durationMs: 5_000, toolCalls: 3 },
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

/** The fixture's Codex session: no row on the sample home, opened at `/session/s-codex-settings`. */
export const CODEX_THREAD_SESSION_ID = 's-codex-settings'

const CODEX_ANSWER = `The cards flashed because \`SettingsPage\` rendered once with empty stores, then again when \`useSettingsStores\` resolved. It now waits on the stores' first read and keeps the old height while it does.

- \`apps/web/src/routes/settings.tsx\`: one render after the first read
- \`EnvironmentCard\`: a fixed min-height, so nothing below it jumps

The new empty-state illustration is above; it uses the theme's own fills.`

const REVIEW_FINDINGS = `**1. The skeleton hides a failed read** — \`settings.tsx:48\`
If the first read fails, the page waits forever. Show the error the store already holds.

**2. Min-height on every card** — \`EnvironmentCard.tsx:31\`
Only the first card needs it; the rest only shift once.

No other issues in the diff.`

/**
 * A Codex session, each thing Codex sends that the phone must draw: a turn
 * with commentary between its tool items (commands Codex read as reads and
 * searches, a patch, a web search, an image it looked at, one it generated),
 * two subagents with a collab wait, and a final answer; the environment's
 * word that subagents finished; a `/compact` operation turn; a `/review` with
 * its markers and findings; and a live turn with a running subagent the
 * phone can stop beside a command left running in a terminal.
 */
export function codexThread(now: number): ThreadState {
  const b = new ThreadBuilder(CODEX_THREAD_SESSION_ID)
  const t1 = 'turn-c1'
  const s1 = now - 3_600_000
  b.turn(t1, 'completed', s1, s1 + 124_000)
    .message(
      t1,
      'c-user-1',
      'user',
      'The settings cards flash on load. Find why, fix it, and draw a new empty-state illustration for the environments list.',
    )
    .thought(t1, 'c-r1', '**Reading the settings route**')
    .message(
      t1,
      'c-a1',
      'assistant',
      "I'll read the settings route and look for what renders twice.",
      [],
      'commentary',
    )
    .tool(t1, 'c-t1', 'commandExecution', 'read', 'completed', {
      toolName: 'commandExecution',
      input: {
        command: 'sed -n 1,140p apps/web/src/routes/settings.tsx',
        commandActions: [
          { type: 'read', path: 'apps/web/src/routes/settings.tsx', name: 'settings.tsx' },
        ],
      },
      locations: [{ path: 'apps/web/src/routes/settings.tsx' }],
    })
    .tool(t1, 'c-t2', 'commandExecution', 'search', 'completed', {
      toolName: 'commandExecution',
      input: {
        command: 'rg -n useSettingsStores apps/web/src',
        commandActions: [{ type: 'search', query: 'useSettingsStores', path: 'apps/web/src' }],
      },
    })
    .subagent(t1, 'c-sub1', {
      title: 'explorer',
      agentType: undefined,
      providerId: 'codex',
      modelId: 'gpt-5.5',
      status: 'completed',
      stoppable: true,
      startedAt: iso(s1 + 20_000),
      finishedAt: iso(s1 + 58_000),
    })
    .subagent(t1, 'c-sub2', {
      title: 'layout-auditor',
      agentType: undefined,
      providerId: 'codex',
      modelId: 'gpt-5.5',
      status: 'completed',
      stoppable: true,
      startedAt: iso(s1 + 21_000),
      finishedAt: iso(s1 + 64_000),
    })
    .tool(t1, 'c-t3', 'Waiting for explorer, layout-auditor', 'other', 'completed', {
      toolName: 'wait',
      input: { receiverThreadIds: ['c-sub1', 'c-sub2'] },
    })
    .message(
      t1,
      'c-a2',
      'assistant',
      'Both agree: the page renders before the stores resolve. The screenshot shows the jump.',
      [picture(20)],
      'commentary',
    )
    .tool(t1, 'c-t4', 'imageView', 'read', 'completed', {
      toolName: 'imageView',
      input: { path: '/tmp/settings-flash.png' },
      locations: [{ path: '/tmp/settings-flash.png' }],
    })
    .tool(t1, 'c-t5', 'fileChange', 'edit', 'completed', {
      toolName: 'fileChange',
      input: {
        changes: [
          { path: 'apps/web/src/routes/settings.tsx', kind: 'update' },
          { path: 'apps/web/src/settings/EnvironmentCard.tsx', kind: 'update' },
        ],
      },
      locations: [
        { path: 'apps/web/src/routes/settings.tsx' },
        { path: 'apps/web/src/settings/EnvironmentCard.tsx' },
      ],
      lineChanges: { added: 18, removed: 6 },
    })
    .tool(t1, 'c-t6', 'commandExecution', 'execute', 'completed', {
      toolName: 'commandExecution',
      input: {
        command: 'pnpm --filter @openmanager/web test settings',
        commandActions: [{ type: 'unknown', command: 'pnpm --filter @openmanager/web test' }],
      },
      outputBytes: 2_410,
      startedAt: iso(s1 + 80_000),
      finishedAt: iso(s1 + 92_500),
    })
    .tool(t1, 'c-t7', 'webSearch', 'fetch', 'completed', {
      toolName: 'webSearch',
      input: { action: 'search', query: 'empty state illustration soft fills' },
    })
    .tool(t1, 'c-t8', 'imageGeneration', 'other', 'completed', {
      toolName: 'imageGeneration',
      input: {
        revisedPrompt:
          'A quiet illustration of three stacked rounded cards on a soft fill, no outlines.',
      },
      startedAt: iso(s1 + 96_000),
      finishedAt: iso(s1 + 118_000),
    })
    .message(t1, 'c-a3', 'assistant', CODEX_ANSWER, [picture(21)], 'final_answer')

  // The environment telling the agent the subagents it started finished.
  const t2 = 'turn-c2'
  const s2 = now - 3_300_000
  b.turn(t2, 'completed', s2, s2 + 6_000, 'subagents')
    .message(
      t2,
      'c-user-2',
      'user',
      '<subagents-finished>\nSubagents you started have finished:\n- explorer: completed\n- layout-auditor: completed\n</subagents-finished>',
    )
    .message(
      t2,
      'c-a4',
      'assistant',
      'Both reports are in; nothing changes the fix.',
      [],
      'final_answer',
    )

  // `/compact`: an operation turn, its marker and how much it saved.
  const t3 = 'turn-c3'
  const s3 = now - 1_800_000
  b.turn(t3, 'completed', s3, s3 + 21_000, 'compact')
    .message(t3, 'c-user-3', 'user', '/compact')
    .notice(t3, 'c-n1', {
      kind: 'compacted',
      message: 'Conversation compacted',
      compaction: { trigger: 'manual', tokensBefore: 148_200, tokensAfter: 18_900 },
    })

  // `/review base main`: its markers, a read between them, and the findings.
  const t4 = 'turn-c4'
  const s4 = now - 1_200_000
  b.turn(t4, 'completed', s4, s4 + 74_000, 'review')
    .message(t4, 'c-user-4', 'user', '/review base main')
    .notice(t4, 'c-n2', {
      kind: 'info',
      message: 'Review started',
      review: { phase: 'started', target: 'changes against main' },
    })
    .tool(t4, 'c-t9', 'commandExecution', 'execute', 'completed', {
      toolName: 'commandExecution',
      input: {
        command: 'git diff main...HEAD',
        commandActions: [{ type: 'unknown', command: 'git diff main...HEAD' }],
      },
      outputBytes: 6_802,
    })
    .notice(t4, 'c-n3', {
      kind: 'info',
      message: 'Review finished',
      review: { phase: 'finished' },
    })
    .message(t4, 'c-a5', 'assistant', REVIEW_FINDINGS)

  // Live: a command left running in a terminal, a subagent the phone can stop.
  const t5 = 'turn-c5'
  const s5 = now - 95_000
  b.turn(t5, 'running', s5)
    .message(
      t5,
      'c-user-5',
      'user',
      'Fix the first finding, keep the dev server up, and check both themes.',
    )
    .message(
      t5,
      'c-a6',
      'assistant',
      'Starting the dev server, then a subagent checks both themes while I fix the read.',
      [],
      'commentary',
    )
    .tool(t5, 'c-t10', 'commandExecution', 'execute', 'in_progress', {
      toolName: 'commandExecution',
      input: {
        command: 'pnpm --filter @openmanager/web dev',
        commandActions: [{ type: 'unknown', command: 'pnpm --filter @openmanager/web dev' }],
      },
      output: '  VITE v7.1.4  ready in 812 ms\n\n  ➜  Local:   http://localhost:5174/\n',
      startedAt: iso(s5 + 4_000),
    })
    .subagent(t5, 'c-sub3', {
      title: 'theme-checker',
      agentType: undefined,
      providerId: 'codex',
      modelId: 'gpt-5.5',
      status: 'running',
      stoppable: true,
      startedAt: iso(s5 + 9_000),
    })
    .tool(t5, 'c-t11', 'Waiting for theme-checker', 'other', 'in_progress', {
      toolName: 'wait',
      input: { receiverThreadIds: ['c-sub3'] },
    })
  return b.state
}

/**
 * The child sessions under the fixture's sessions, by parent, as the
 * environment's summaries list them: the recorded run's subagent writing
 * contract tests, and one it started in turn, waiting on a permission. The
 * subagent strip draws them nested; the nested one's record is on its
 * parent's thread, which the phone does not hold, so it is drawn from its
 * summary alone, as a live one would be.
 */
export const FIXTURE_LINEAGE: Record<string, LineageSession[]> = {
  's-tool-payloads': [
    {
      sessionId: 's-tool-payloads-tests',
      title: 'Contract tests for turn_activity',
      status: 'running',
      providerId: 'claude',
      parentSessionId: 's-tool-payloads',
      subagent: { subagentId: 'live-sub', origin: 'native', promptable: false },
    },
    {
      sessionId: 's-tool-payloads-cursor',
      title: 'Record Cursor fixtures',
      status: 'waiting',
      waitingOn: 'permission',
      providerId: 'codex',
      parentSessionId: 's-tool-payloads-tests',
      subagent: { subagentId: 'nested-cursor', origin: 'openmanager', promptable: true },
    },
  ],
}

/** The background work the fixture's sessions left running, by session. */
export const FIXTURE_TASKS: Record<string, BackgroundTask[]> = {
  [CODEX_THREAD_SESSION_ID]: [
    { taskId: 'c-t10', kind: 'shell', description: 'pnpm --filter @openmanager/web dev' },
  ],
}

const DELEGATED_BRIEF = `You are writing contract tests for \`turn_activity\`.

Context: the runtime forwards \`rawInput\` and \`rawOutput\` for every tool call, and \`projectAgentEvent\` now carries them through to the protocol as \`input\` and \`output\`. Nothing checks that end to end yet.

1. Add a test per provider fixture (Claude, Cursor, OpenCode, Codex) that projects the recorded events and asserts every settled tool has \`input\`.
2. Assert no settled tool carries \`output\` text: settled text never travels in events.
3. Assert \`lineChanges\` survives for edits, and that a diff never does.

Keep the tests in \`packages/agent-runtime/src/protocol\`. Run the protocol suite when done and report what failed, if anything.`

/** A subagent's own session: the brief its parent gave it, and its work so far. */
export function delegatedThread(now: number): ThreadState {
  const b = new ThreadBuilder('s-tool-payloads-tests')
  const turn = 'turn-dl1'
  b.turn(turn, 'running', now - 48_000, undefined, 'delegated')
    .message(turn, 'dl-user', 'user', DELEGATED_BRIEF)
    .message(
      turn,
      'dl-a1',
      'assistant',
      'Reading the recorded fixtures first, then one test per provider.',
    )
    .tool(turn, 'dl-t1', 'Glob', 'search', 'completed', {
      toolName: 'Glob',
      input: { pattern: 'packages/agent-runtime/src/**/fixtures/*.jsonl' },
    })
    .tool(turn, 'dl-t2', 'Write', 'edit', 'in_progress', {
      toolName: 'Write',
      input: { file_path: 'packages/agent-runtime/src/protocol/turn-activity.contract.test.ts' },
      locations: [{ path: 'packages/agent-runtime/src/protocol/turn-activity.contract.test.ts' }],
    })
  return b.state
}
