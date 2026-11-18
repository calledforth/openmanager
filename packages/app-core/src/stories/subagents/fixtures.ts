import {
  createMockEnvironmentClient,
  type MockEnvironmentClient,
  type MockSeedSession,
} from '@openmanager/environment-client'
import type { Interaction, Message, ProofEvent, Subagent, Turn } from '@openmanager/protocol'

/**
 * One environment where an agent has delegated work every way it can: a
 * Claude parent that ran native subagents (one done, one failed, one running,
 * one waiting on a permission), spawned three agents on other providers in
 * the background, and was woken when two of them finished. Its children are
 * real sessions, so the stories can open them: read-only Claude subagents,
 * a promptable spawned one, and a subagent of a subagent.
 */

const ENV = 'env-story'
const WORKSPACE = {
  workspaceId: '/work/openmanager',
  name: 'openmanager',
  path: '/work/openmanager',
  lastUsedAt: null,
  lastActivityAt: null,
  capabilities: { git: true },
  exists: true,
}

export const PARENT = 'session-parent'
const PARENT_THREAD = 'session-parent-thread'

export const CHILD = {
  callers: 'session-callers',
  tests: 'session-tests',
  mobile: 'session-mobile',
  staging: 'session-staging',
  rotate: 'session-rotate',
  scrub: 'session-scrub',
  cookie: 'session-cookie',
  keychain: 'session-keychain',
} as const

const threadOf = (sessionId: string) => `${sessionId}-thread`

/** Times relative to when the story opens, so a running card's clock reads true. */
const ago = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString()

const text = (value: string) => ({ type: 'text' as const, text: value })

function userMessage(sessionId: string, turnId: string, value: string): Message {
  return {
    messageId: `${turnId}-prompt`,
    threadId: threadOf(sessionId),
    turnId,
    role: 'user',
    content: [text(value)],
  }
}

function turn(
  sessionId: string,
  turnId: string,
  state: Turn['state'],
  startedSecondsAgo: number,
  durationSeconds: number | null,
  origin?: Turn['origin'],
): Turn {
  return {
    turnId,
    threadId: threadOf(sessionId),
    state,
    startedAt: ago(startedSecondsAgo),
    ...(durationSeconds !== null ? { finishedAt: ago(startedSecondsAgo - durationSeconds) } : {}),
    ...(origin ? { origin } : {}),
  }
}

type Base = Pick<Subagent, 'subagentId' | 'turnId' | 'title' | 'status'> & Partial<Subagent>

function record(parentSessionId: string, base: Base): Subagent {
  return {
    parentSessionId,
    depth: 1,
    origin: 'native',
    providerId: 'claude',
    modelId: 'claude-sonnet-4-5-20250929',
    background: false,
    promptable: false,
    stoppable: true,
    stats: {},
    startedAt: ago(60),
    updatedAt: ago(1),
    ...base,
  }
}

/** The parent's subagents, as its thread holds them. */
export const PARENT_SUBAGENTS: Subagent[] = [
  record(PARENT, {
    subagentId: 'sa-callers',
    turnId: 'p-turn-1',
    toolCallId: 'call-callers',
    childSessionId: CHILD.callers,
    title: 'Map every caller of verifySession',
    agentType: 'Explore',
    modelId: 'claude-haiku-4-5-20251001',
    status: 'completed',
    stats: { toolCalls: 14, tokens: 31_420, durationMs: 48_000 },
    startedAt: ago(1_840),
    finishedAt: ago(1_792),
    result:
      'Found **7 callers** of `verifySession` across 4 files.\n\n- `apps/server/src/http/auth.ts`: the HTTP middleware, reads the cookie\n- `apps/server/src/ws/handshake.ts`: the WebSocket upgrade, reads a query token\n- `apps/server/src/pairing.ts`: pairing redemption\n- `apps/server/src/routes/artifacts.ts` (3 calls): artifact streaming\n\nThe WebSocket path is the odd one out: it accepts the token as `?token=` in the URL, which ends up in request logs.',
  }),
  record(PARENT, {
    subagentId: 'sa-tests',
    turnId: 'p-turn-1',
    toolCallId: 'call-tests',
    childSessionId: CHILD.tests,
    title: 'Run the auth integration suite',
    agentType: 'general-purpose',
    status: 'failed',
    stats: { toolCalls: 3, tokens: 6_870, durationMs: 21_000 },
    startedAt: ago(1_780),
    finishedAt: ago(1_759),
    statusReason: 'pnpm test:auth exited 1: Postgres is not listening on localhost:5432',
  }),
  record(PARENT, {
    subagentId: 'sa-rotate',
    turnId: 'p-turn-2',
    toolCallId: 'call-rotate',
    childSessionId: CHILD.rotate,
    origin: 'openmanager',
    providerId: 'cursor',
    modelId: 'gpt-5.1-codex',
    title: 'Rotate refresh tokens on reuse',
    status: 'running',
    background: true,
    promptable: true,
    stats: { toolCalls: 22, tokens: 88_200 },
    startedAt: ago(1_210),
    activity: 'Editing apps/server/src/auth/refresh.ts',
  }),
  record(PARENT, {
    subagentId: 'sa-scrub',
    turnId: 'p-turn-2',
    toolCallId: 'call-scrub',
    childSessionId: CHILD.scrub,
    origin: 'openmanager',
    providerId: 'opencode',
    modelId: 'kimi-k2',
    title: 'Scrub tokens from request logs',
    status: 'completed',
    background: true,
    promptable: true,
    stats: { toolCalls: 9, tokens: 24_050, durationMs: 156_000 },
    startedAt: ago(1_205),
    finishedAt: ago(1_049),
    result:
      'Request logs now redact `token`, `access_token` and `refresh_token` query parameters and the `Authorization` header. Added a unit test for each.',
  }),
  record(PARENT, {
    subagentId: 'sa-cookie',
    turnId: 'p-turn-2',
    toolCallId: 'call-cookie',
    childSessionId: CHILD.cookie,
    origin: 'openmanager',
    providerId: 'claude',
    modelId: 'claude-opus-4-1',
    title: 'Set SameSite=Strict on the session cookie',
    status: 'completed',
    background: true,
    promptable: true,
    stats: { toolCalls: 6, tokens: 15_300, durationMs: 98_000 },
    startedAt: ago(1_200),
    finishedAt: ago(1_102),
    result:
      'Cookie is now `HttpOnly; Secure; SameSite=Strict`. Pairing still works: it never relied on the cookie.',
  }),
  record(PARENT, {
    subagentId: 'sa-mobile',
    turnId: 'p-turn-4',
    toolCallId: 'call-mobile',
    childSessionId: CHILD.mobile,
    title: 'Audit token storage in the mobile app',
    agentType: 'Explore',
    modelId: 'claude-haiku-4-5-20251001',
    status: 'running',
    stats: { toolCalls: 11, tokens: 19_800 },
    startedAt: ago(74),
    activity: 'Reading apps/mobile/src/auth/secure-store.ts',
  }),
  record(PARENT, {
    subagentId: 'sa-staging',
    turnId: 'p-turn-4',
    toolCallId: 'call-staging',
    childSessionId: CHILD.staging,
    title: 'Apply the cookie fix to the staging config',
    agentType: 'general-purpose',
    status: 'waiting',
    waitingOn: 'permission',
    stats: { toolCalls: 4, tokens: 7_420 },
    startedAt: ago(41),
  }),
]

/** The mobile audit's own subagent: depth 2, on that child's thread. */
const MOBILE_SUBAGENTS: Subagent[] = [
  record(CHILD.mobile, {
    subagentId: 'sa-keychain',
    turnId: `${CHILD.mobile}-turn-1`,
    toolCallId: 'call-keychain',
    childSessionId: CHILD.keychain,
    parentSubagentId: 'sa-mobile',
    depth: 2,
    title: 'Check Keychain access groups on iOS',
    agentType: 'Explore',
    modelId: 'claude-haiku-4-5-20251001',
    status: 'running',
    stats: { toolCalls: 3, tokens: 4_100 },
    startedAt: ago(22),
    activity: 'Searching for kSecAttrAccessGroup',
  }),
]

const SUBAGENTS_NOTICE =
  'Subagents finished: Scrub tokens from request logs (completed), Set SameSite=Strict on the session cookie (completed).\n\n## Scrub tokens from request logs: completed\nRequest logs now redact `token`, `access_token` and `refresh_token` query parameters and the `Authorization` header.\n\n## Set SameSite=Strict on the session cookie: completed\nCookie is now `HttpOnly; Secure; SameSite=Strict`.\n\nCall wait_agent with an id for the rest of an answer.'

function child(
  sessionId: string,
  title: string,
  options: {
    providerId?: string
    status?: MockSeedSession['status']
    subagentId: string
    origin?: 'native' | 'openmanager'
    promptable?: boolean
    parent?: string
    prompt: string
    turnState: Turn['state']
    startedSecondsAgo: number
    duration: number | null
  },
): MockSeedSession {
  const turnId = `${sessionId}-turn-1`
  return {
    session: {
      sessionId,
      workspaceId: WORKSPACE.workspaceId,
      title,
      parentSessionId: options.parent ?? PARENT,
    },
    subagent: {
      subagentId: options.subagentId,
      origin: options.origin ?? 'native',
      promptable: options.promptable ?? false,
    },
    providerId: options.providerId ?? 'claude',
    status: options.status ?? 'idle',
    updatedAt: ago(options.startedSecondsAgo - (options.duration ?? 0)),
    threads: [{ threadId: threadOf(sessionId), sessionId }],
    turns: [
      turn(
        sessionId,
        turnId,
        options.turnState,
        options.startedSecondsAgo,
        options.duration,
        'delegated',
      ),
    ],
    messages: [userMessage(sessionId, turnId, options.prompt)],
  }
}

const PARENT_PROMPT_1 =
  'Audit how sessions are authenticated across the server and tell me where a token can leak.'
const PARENT_PROMPT_2 = 'Fix all three. Run them in parallel, on whichever agents fit best.'
const PARENT_PROMPT_4 = 'Good. Now check the mobile app, and apply the cookie fix to staging too.'

function seedSessions(): MockSeedSession[] {
  const sessions: MockSeedSession[] = [
    {
      session: {
        sessionId: PARENT,
        workspaceId: WORKSPACE.workspaceId,
        title: 'Harden session authentication',
      },
      providerId: 'claude',
      status: 'waiting',
      updatedAt: ago(1),
      threads: [{ threadId: PARENT_THREAD, sessionId: PARENT }],
      turns: [
        turn(PARENT, 'p-turn-1', 'completed', 1_860, 132),
        turn(PARENT, 'p-turn-2', 'completed', 1_220, 26),
        turn(PARENT, 'p-turn-3', 'completed', 1_040, 18, 'subagents'),
        turn(PARENT, 'p-turn-4', 'waiting', 80, null),
      ],
      messages: [
        { ...userMessage(PARENT, 'p-turn-1', PARENT_PROMPT_1), threadId: PARENT_THREAD },
        { ...userMessage(PARENT, 'p-turn-2', PARENT_PROMPT_2), threadId: PARENT_THREAD },
        { ...userMessage(PARENT, 'p-turn-3', SUBAGENTS_NOTICE), threadId: PARENT_THREAD },
        { ...userMessage(PARENT, 'p-turn-4', PARENT_PROMPT_4), threadId: PARENT_THREAD },
      ],
      subagents: { [PARENT_THREAD]: PARENT_SUBAGENTS },
      queues: {
        [PARENT_THREAD]: {
          pausedBy: null,
          items: [
            {
              queueItemId: 'q-notice',
              text: 'Subagents finished: Rotate refresh tokens on reuse (completed).\n\nRefresh tokens are single-use now.',
              settings: {},
              delivery: 'queued',
              createdAt: ago(2),
              origin: 'subagents',
            },
            {
              queueItemId: 'q-user',
              text: 'Then open a PR with everything.',
              settings: {},
              delivery: 'queued',
              createdAt: ago(1),
            },
          ],
        },
      },
    },
    child(CHILD.callers, 'Map every caller of verifySession', {
      subagentId: 'sa-callers',
      prompt:
        'Find every caller of `verifySession` in apps/server. For each, say where the token comes from (cookie, header, query) and whether it can end up in a log. Report file paths and a one-line verdict per caller. Do not change any code.',
      turnState: 'completed',
      startedSecondsAgo: 1_840,
      duration: 48,
    }),
    child(CHILD.tests, 'Run the auth integration suite', {
      subagentId: 'sa-tests',
      status: 'error',
      prompt: 'Run `pnpm test:auth` and summarise any failures.',
      turnState: 'failed',
      startedSecondsAgo: 1_780,
      duration: 21,
    }),
    child(CHILD.rotate, 'Rotate refresh tokens on reuse', {
      subagentId: 'sa-rotate',
      providerId: 'cursor',
      origin: 'openmanager',
      promptable: true,
      status: 'running',
      prompt:
        'Make refresh tokens single-use: rotate on every refresh, and revoke the whole family when a used token comes back.',
      turnState: 'running',
      startedSecondsAgo: 1_210,
      duration: null,
    }),
    child(CHILD.scrub, 'Scrub tokens from request logs', {
      subagentId: 'sa-scrub',
      providerId: 'opencode',
      origin: 'openmanager',
      promptable: true,
      prompt: 'Redact tokens from the request logger, query string and headers both.',
      turnState: 'completed',
      startedSecondsAgo: 1_205,
      duration: 156,
    }),
    child(CHILD.cookie, 'Set SameSite=Strict on the session cookie', {
      subagentId: 'sa-cookie',
      origin: 'openmanager',
      promptable: true,
      prompt: 'Set SameSite=Strict on the session cookie and check pairing still works.',
      turnState: 'completed',
      startedSecondsAgo: 1_200,
      duration: 98,
    }),
    child(CHILD.mobile, 'Audit token storage in the mobile app', {
      subagentId: 'sa-mobile',
      status: 'running',
      prompt:
        'Look at how apps/mobile stores the session token and the pairing credential. Is anything in AsyncStorage that should be in the secure store? Check iOS Keychain access groups too.',
      turnState: 'running',
      startedSecondsAgo: 74,
      duration: null,
    }),
    child(CHILD.staging, 'Apply the cookie fix to the staging config', {
      subagentId: 'sa-staging',
      status: 'waiting',
      prompt:
        'Apply the SameSite=Strict change to deploy/staging/server.env and restart the staging server with `fly deploy -c deploy/staging/fly.toml`.',
      turnState: 'waiting',
      startedSecondsAgo: 41,
      duration: null,
    }),
    {
      ...child(CHILD.keychain, 'Check Keychain access groups on iOS', {
        subagentId: 'sa-keychain',
        parent: CHILD.mobile,
        status: 'running',
        prompt: 'Check which Keychain access group the iOS app writes the token under.',
        turnState: 'running',
        startedSecondsAgo: 22,
        duration: null,
      }),
    },
  ]
  return sessions.map((entry) =>
    entry.session.sessionId === CHILD.mobile
      ? { ...entry, subagents: { [threadOf(CHILD.mobile)]: MOBILE_SUBAGENTS } }
      : entry,
  )
}

type Target = { sessionId: string; threadId: string; turnId: string }
type Step =
  | { text: string }
  | {
      tool: string
      id: string
      kind?: 'read' | 'search' | 'execute' | 'edit' | 'think' | 'other'
      title?: string
      input?: Record<string, string>
      running?: boolean
      seconds?: number
    }

/** Play a turn's agent side into the thread in order: text, then its tool calls. */
function play(client: MockEnvironmentClient, target: Target, steps: Step[]) {
  const scope = {
    type: 'thread' as const,
    environmentId: client.getState().environment?.environmentId ?? ENV,
    sessionId: target.sessionId,
    threadId: target.threadId,
  }
  let index = 0
  for (const step of steps) {
    index += 1
    const base = {
      type: 'event' as const,
      eventId: `${target.turnId}-e${index}`,
      timestamp: ago(0),
    }
    if ('text' in step) {
      client.emit({
        ...base,
        name: 'message.delta',
        scope,
        payload: {
          messageId: `${target.turnId}-text-${index}`,
          turnId: target.turnId,
          role: 'assistant',
          content: text(step.text),
        },
      } satisfies ProofEvent)
      continue
    }
    client.emit({
      ...base,
      name: 'tool.updated',
      scope,
      payload: {
        toolCallId: step.id,
        turnId: target.turnId,
        toolName: step.tool,
        ...(step.title ? { title: step.title } : {}),
        kind: step.kind ?? 'other',
        status: step.running ? 'in_progress' : 'completed',
        ...(step.input ? { input: step.input } : {}),
        startedAt: ago(step.seconds ?? 60),
        ...(step.running ? {} : { finishedAt: ago((step.seconds ?? 60) - 2) }),
      },
    } satisfies ProofEvent)
  }
}

const read = (id: string, path: string, running = false): Step => ({
  tool: 'Read',
  id,
  kind: 'read',
  input: { file_path: path },
  running,
})
const grep = (id: string, pattern: string): Step => ({
  tool: 'Grep',
  id,
  kind: 'search',
  input: { pattern },
})
const agent = (id: string, description: string): Step => ({
  tool: 'Agent',
  id,
  kind: 'think',
  input: { description, prompt: description },
})
const spawn = (id: string, title: string): Step => ({
  tool: 'mcp__openmanager__spawn_agent',
  id,
  kind: 'other',
  input: { title },
})

const at = (sessionId: string, turnId: string): Target => ({
  sessionId,
  threadId: sessionId === PARENT ? PARENT_THREAD : threadOf(sessionId),
  turnId,
})

const STAGING_PERMISSION: Interaction = {
  kind: 'permission',
  interactionId: 'perm-staging',
  toolCall: {
    toolCallId: 'st-deploy',
    title: 'fly deploy -c deploy/staging/fly.toml',
    kind: 'execute',
  },
  options: [
    { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
    { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
    { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
  ],
}

/** The whole environment, with `activeSessionId` open. */
export function createSubagentsClient(activeSessionId: string = PARENT): MockEnvironmentClient {
  const client = createMockEnvironmentClient({
    seed: {
      workspaces: [WORKSPACE],
      sessions: seedSessions(),
      activeSessionId,
    },
    respond: () => null,
  })

  play(client, at(PARENT, 'p-turn-1'), [
    { text: 'I’ll start from the middleware and fan out from there.' },
    read('p1-read', 'apps/server/src/http/auth.ts'),
    grep('p1-grep', 'verifySession'),
    agent('call-callers', 'Map every caller of verifySession'),
    { text: 'While that maps the call sites, I’ll have the integration suite run.' },
    agent('call-tests', 'Run the auth integration suite'),
    {
      text: 'Tokens can leak in three places:\n\n1. **WebSocket handshake**: the token rides in `?token=`, so it lands in request logs.\n2. **Refresh tokens** are reusable: a stolen one works until it expires.\n3. **Session cookie** has no `SameSite`, so it goes out on cross-site requests.\n\nThe integration suite could not run (Postgres is down locally), so none of this is test-verified yet.',
    },
  ])
  play(client, at(PARENT, 'p-turn-2'), [
    { text: 'Splitting this three ways, each on the agent that suits it.' },
    spawn('call-rotate', 'Rotate refresh tokens on reuse'),
    spawn('call-scrub', 'Scrub tokens from request logs'),
    spawn('call-cookie', 'Set SameSite=Strict on the session cookie'),
    { text: 'All three are running in the background. I’ll pick up their results as they land.' },
  ])
  play(client, at(PARENT, 'p-turn-3'), [
    {
      text: 'Log scrubbing and the cookie change are in. Refresh-token rotation is still going on Cursor.',
    },
  ])
  play(client, at(PARENT, 'p-turn-4'), [
    { text: 'Two more, side by side.' },
    agent('call-mobile', 'Audit token storage in the mobile app'),
    read('p4-read', 'deploy/staging/server.env'),
    agent('call-staging', 'Apply the cookie fix to the staging config'),
  ])

  // The children's own work, as their pages stream it.
  play(client, at(CHILD.callers, `${CHILD.callers}-turn-1`), [
    grep('c-grep', 'verifySession('),
    read('c-r1', 'apps/server/src/http/auth.ts'),
    read('c-r2', 'apps/server/src/ws/handshake.ts'),
    read('c-r3', 'apps/server/src/pairing.ts'),
    read('c-r4', 'apps/server/src/routes/artifacts.ts'),
    { text: PARENT_SUBAGENTS[0]!.result! },
  ])
  play(client, at(CHILD.mobile, `${CHILD.mobile}-turn-1`), [
    { text: 'Starting with where the app writes credentials.' },
    grep('m-grep', 'AsyncStorage.setItem'),
    read('m-r1', 'apps/mobile/src/auth/session.ts'),
    agent('call-keychain', 'Check Keychain access groups on iOS'),
    read('m-r2', 'apps/mobile/src/auth/secure-store.ts', true),
  ])
  play(client, at(CHILD.staging, `${CHILD.staging}-turn-1`), [
    read('st-read', 'deploy/staging/server.env'),
    {
      tool: 'Edit',
      id: 'st-edit',
      kind: 'edit',
      input: { file_path: 'deploy/staging/server.env' },
    },
    {
      tool: 'Bash',
      id: 'st-deploy',
      kind: 'execute',
      input: { command: 'fly deploy -c deploy/staging/fly.toml' },
      running: true,
    },
  ])
  client.requestInteraction(at(CHILD.staging, `${CHILD.staging}-turn-1`), STAGING_PERMISSION)
  play(client, at(CHILD.rotate, `${CHILD.rotate}-turn-1`), [
    { text: 'I’ll add a token family id so a reused token can revoke its whole chain.' },
    read('r-r1', 'apps/server/src/auth/refresh.ts'),
    {
      tool: 'Edit',
      id: 'r-e1',
      kind: 'edit',
      input: { file_path: 'apps/server/src/auth/refresh.ts' },
      running: true,
    },
  ])
  return client
}
