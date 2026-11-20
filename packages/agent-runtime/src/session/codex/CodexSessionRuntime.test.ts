import { describe, expect, it, vi } from 'vitest'
import type { BackendEvent } from '../../backends/Backend.js'
import { SessionUnknownError } from '../../core/errors.js'
import { InteractionBroker } from '../../core/InteractionBroker.js'
import { PermissionBroker } from '../../core/PermissionBroker.js'
import { codex } from '../../providers/codex.js'
import type { SessionRuntimeSpec } from '../SessionRuntime.js'
import { CodexAppServerClient } from './CodexAppServerClient.js'
import { CodexSessionRuntime } from './CodexSessionRuntime.js'
import type { CodexStarter } from './start.js'
import { FakeCodexAppServer, type FakeCodexTurn } from './testing/index.js'
import { ReplayCodexAppServer } from './testing/ReplayCodexAppServer.js'

const MODELS = {
  data: [
    {
      id: 'gpt-6-luna',
      model: 'gpt-6-luna',
      displayName: 'gpt-6-luna',
      description: '',
      hidden: false,
      isDefault: true,
      supportedReasoningEfforts: [],
      defaultReasoningEffort: 'low',
      inputModalities: ['text', 'image'],
    },
    {
      id: 'gpt-6.2-sol',
      model: 'gpt-6.2-sol',
      displayName: 'gpt-6.2-sol',
      description: '',
      hidden: false,
      isDefault: false,
      supportedReasoningEfforts: [],
      defaultReasoningEffort: 'low',
      inputModalities: ['text'],
    },
  ],
  nextCursor: null,
}

const PROMPT = { text: 'hi', blocks: [{ type: 'text' as const, text: 'hi' }] }

/** A runtime on a fake app-server. `onTurn` scripts each turn once Codex has
 * announced it; leave it out to drive turns by hand. */
function build(
  options: {
    spec?: Partial<SessionRuntimeSpec>
    onTurn?: (turn: FakeCodexTurn) => void
    server?: FakeCodexAppServer
    interruptGraceMs?: number
  } = {},
) {
  const server = options.server ?? new FakeCodexAppServer()
  if (!options.server) {
    server.respond('model/list', MODELS as never)
    server.serveThreads(options.onTurn)
  }
  const log = vi.fn()
  const start: CodexStarter = async () => {
    const client = new CodexAppServerClient(server, {
      log,
      terminateGraceMs: 50,
      requestTimeoutMs: 2_000,
      exitDrainMs: 10,
    })
    await client.initialize({ clientVersion: 'test' })
    return client
  }
  const events: BackendEvent[] = []
  const runtime = new CodexSessionRuntime(
    { threadId: 'thread-1', providerId: 'codex', cwd: '/work', ...options.spec },
    {
      config: codex,
      host: { log },
      permissions: new PermissionBroker(),
      interactions: new InteractionBroker(),
      start,
      platform: 'linux',
      timeouts: { interruptGraceMs: options.interruptGraceMs ?? 200 },
    },
  )
  runtime.events((event) => events.push(event))
  const exits: unknown[] = []
  runtime.onExit((exit) => exits.push(exit))
  return { server, runtime, events, exits, log }
}

const names = (events: BackendEvent[]) => events.map((event) => event.event)
const texts = (events: BackendEvent[]) =>
  events
    .filter((e) => e.event === 'agent_message_chunk')
    .map((e) => (e.data as { content: { text: string } }).content.text)
    .join('')

describe('CodexSessionRuntime start', () => {
  it('opens a thread with the access preset and our thread config, then announces it', async () => {
    const { server, runtime, events } = build({ spec: { instructions: 'Be brief.' } })
    const result = await runtime.start()

    expect(result.state).toBe('created')
    expect(runtime.sessionId).toBe(result.sessionId)
    expect(runtime.phase).toBe('ready')
    const [request] = server.requests('thread/start')
    expect(request!.params).toMatchObject({
      cwd: '/work',
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandbox: 'workspace-write',
      config: { notify: [] },
      historyMode: 'paginated',
      developerInstructions: 'Be brief.',
    })
    expect(names(events)).toEqual(['process_spawned', 'initialized', 'session_created'])
    expect(events[2]).toMatchObject({
      sessionId: result.sessionId,
      data: { models: { availableModels: [{ id: 'gpt-6-luna' }, { id: 'gpt-6.2-sol' }] } },
    })
    await expect(runtime.start()).resolves.toMatchObject({ state: 'reused' })
  })

  it('defaults native Windows to Full access', async () => {
    const server = new FakeCodexAppServer()
    server.respond('model/list', MODELS as never).serveThreads()
    const { runtime } = build({ server })
    // Rebuild with win32: the preset is chosen at construction.
    const win = new CodexSessionRuntime(
      { threadId: 't', providerId: 'codex', cwd: '/work' },
      {
        config: codex,
        host: { log: vi.fn() },
        permissions: new PermissionBroker(),
        interactions: new InteractionBroker(),
        platform: 'win32',
        start: async () => {
          const client = new CodexAppServerClient(server, {
            log: vi.fn(),
            terminateGraceMs: 50,
            requestTimeoutMs: 2_000,
          })
          await client.initialize({ clientVersion: 't' })
          return client
        },
      },
    )
    await win.start()
    expect(server.requests('thread/start')[0]!.params).toMatchObject({
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
    })
    runtime.dispose()
    win.dispose()
  })

  it('resumes a stored thread without its turns', async () => {
    const server = new FakeCodexAppServer()
    server.respond('model/list', MODELS as never)
    const thread = server.thread({ id: 'stored' })
    server.respond('thread/resume', thread.startResponse() as never)
    const { runtime, events } = build({ server, spec: { sessionId: 'stored' } })

    await expect(runtime.start()).resolves.toMatchObject({ sessionId: 'stored', state: 'loaded' })
    expect(server.requests('thread/resume')[0]!.params).toMatchObject({
      threadId: 'stored',
      excludeTurns: true,
      config: { notify: [] },
    })
    expect(names(events)).toContain('session_loaded')
  })

  it('starts fresh when Codex no longer has the thread', async () => {
    const server = new FakeCodexAppServer()
    server.respond('model/list', MODELS as never).serveThreads()
    server.fail('thread/resume', -32600, 'no rollout found for thread id gone')
    const { runtime, events } = build({ server, spec: { sessionId: 'gone' } })

    const result = await runtime.start()
    expect(result.state).toBe('created')
    expect(result.sessionId).not.toBe('gone')
    expect(names(events)).toContain('session_created')
  })

  it('refuses to start fresh when the stored thread is required', async () => {
    const server = new FakeCodexAppServer()
    server.respond('model/list', MODELS as never).serveThreads()
    server.fail('thread/resume', -32600, 'no rollout found for thread id gone')
    const { runtime, exits } = build({ server, spec: { sessionId: 'gone', load: 'require' } })

    await expect(runtime.start()).rejects.toBeInstanceOf(SessionUnknownError)
    expect(server.requests('thread/start')).toHaveLength(0)
    expect(runtime.phase).toBe('exited')
    expect(exits).toMatchObject([{ reason: 'start_failed', expected: true }])
  })

  // Any other resume failure is not "the thread is gone" and must not
  // silently replace the user's thread with an empty one.
  it('does not fall back on a resume failure that is not "not found"', async () => {
    const server = new FakeCodexAppServer()
    server.respond('model/list', MODELS as never).serveThreads()
    server.fail('thread/resume', -32603, 'database is locked')
    const { runtime } = build({ server, spec: { sessionId: 'stored' } })
    await expect(runtime.start()).rejects.toThrow(/database is locked/)
    expect(server.requests('thread/start')).toHaveLength(0)
  })
})

describe('CodexSessionRuntime turns', () => {
  it('streams a turn and resolves on turn/completed, not on the RPC', async () => {
    let turn: FakeCodexTurn | undefined
    const { server, runtime, events } = build({ onTurn: (t) => (turn = t) })
    await runtime.start()

    let resolved = false
    const prompt = runtime
      .prompt({ prompt: PROMPT, userMessageId: 'msg-1', desiredConfig: { modelId: 'gpt-6.2-sol' } })
      .then(() => (resolved = true))
    await vi.waitFor(() => expect(turn).toBeDefined())
    const [request] = server.requests('turn/start')
    expect(request!.params).toMatchObject({
      input: [{ type: 'text', text: 'hi' }],
      clientUserMessageId: 'msg-1',
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandboxPolicy: { type: 'workspaceWrite' },
      summary: 'detailed',
      model: 'gpt-6.2-sol',
    })

    turn!.reasoning(['**Thinking it over**'])
    turn!.agentMessage('Hello there', { chunks: ['Hello', ' there'] })
    turn!.tokenUsage({ totalTokens: 50, inputTokens: 40, outputTokens: 10 })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(resolved).toBe(false)

    turn!.completed()
    await prompt
    expect(texts(events)).toBe('Hello there')
    const turnEvents = names(events).slice(names(events).indexOf('prompt_started'))
    expect(turnEvents[0]).toBe('prompt_started')
    expect(turnEvents).toContain('agent_thought_chunk')
    expect(turnEvents.slice(-2)).toEqual(['prompt_completed', 'usage_update'])
    expect(events.find((e) => e.event === 'prompt_started')).toMatchObject({
      data: { prompt: 'hi', userMessageId: 'msg-1' },
    })
    expect(events.find((e) => e.event === 'prompt_completed')).toMatchObject({
      data: { stopReason: 'end_turn', usage: { totalTokens: 50, inputTokens: 40, outputTokens: 10 } },
    })
    // The chosen model is reported, as a whole listing.
    expect(events.find((e) => e.event === 'current_model_update')).toMatchObject({
      data: { currentModelId: 'gpt-6.2-sol', availableModels: expect.any(Array) },
    })
  })

  it('fails a turn Codex reports as failed: one error, no completion, and the prompt rejects', async () => {
    const { runtime, events } = build({ onTurn: (t) => t.failed('The model is overloaded') })
    await runtime.start()
    await expect(runtime.prompt({ prompt: PROMPT })).rejects.toThrow(/overloaded/)
    expect(names(events)).not.toContain('prompt_completed')
    expect(events.filter((e) => e.event === 'runtime_error')).toHaveLength(1)
  })

  it('drops events for a turn that already ended', async () => {
    let turn: FakeCodexTurn | undefined
    const { runtime, events } = build({ onTurn: (t) => (turn = t) })
    await runtime.start()
    const prompt = runtime.prompt({ prompt: PROMPT })
    await vi.waitFor(() => expect(turn).toBeDefined())
    turn!.completed()
    await prompt
    const before = events.length
    // An interrupted command's completion has been seen 17 s after its turn.
    turn!.agentMessage('late')
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(events.length).toBe(before)
  })

  it('never applies another thread’s notifications to this session', async () => {
    let turn: FakeCodexTurn | undefined
    const { runtime, events } = build({ onTurn: (t) => (turn = t) })
    await runtime.start()
    const prompt = runtime.prompt({ prompt: PROMPT })
    await vi.waitFor(() => expect(turn).toBeDefined())
    const child = turn!.thread.child()
    child.turn().started().agentMessage('from the subagent')
    turn!.agentMessage('from the parent')
    turn!.completed()
    await prompt
    expect(texts(events)).toBe('from the parent')
  })

  it('refuses a second prompt while a turn runs', async () => {
    const { runtime } = build({ onTurn: () => undefined })
    await runtime.start()
    void runtime.prompt({ prompt: PROMPT }).catch(() => undefined)
    await expect(runtime.prompt({ prompt: PROMPT })).rejects.toThrow(/already running/)
    runtime.dispose()
  })

  it('declines approvals until there is a UI for them', async () => {
    let turn: FakeCodexTurn | undefined
    const { runtime } = build({ onTurn: (t) => (turn = t) })
    await runtime.start()
    const prompt = runtime.prompt({ prompt: PROMPT })
    await vi.waitFor(() => expect(turn).toBeDefined())
    const command = turn!.commandStarted('rm -rf build')
    const answer = await turn!.requestCommandApproval(command)
    expect(answer).toMatchObject({ result: { decision: 'decline' } })
    turn!.completed()
    await prompt
  })
})

describe('CodexSessionRuntime interrupt and exit', () => {
  it('interrupts the running turn and resolves with a cancelled stop reason', async () => {
    let turn: FakeCodexTurn | undefined
    const { server, runtime, events } = build({ onTurn: (t) => (turn = t) })
    server.respond('turn/interrupt', () => {
      setTimeout(() => turn!.interrupted(), 5)
      return {} as never
    })
    await runtime.start()
    const prompt = runtime.prompt({ prompt: PROMPT })
    await vi.waitFor(() => expect(turn).toBeDefined())

    await runtime.cancel()
    await prompt
    expect(server.requests('turn/interrupt')[0]!.params).toMatchObject({ turnId: turn!.id })
    expect(events.find((e) => e.event === 'prompt_completed')).toMatchObject({
      data: { stopReason: 'cancelled' },
    })
  })

  it('closes the turn itself when Codex never finishes the interrupt', async () => {
    let turn: FakeCodexTurn | undefined
    const { server, runtime, events } = build({ onTurn: (t) => (turn = t), interruptGraceMs: 20 })
    server.respond('turn/interrupt', {} as never)
    await runtime.start()
    const prompt = runtime.prompt({ prompt: PROMPT })
    await vi.waitFor(() => expect(turn).toBeDefined())
    turn!.reasoning([]) // a reasoning item left open
    await runtime.cancel()
    await prompt
    const thoughts = events.filter((e) => e.event === 'agent_thought_chunk')
    expect((thoughts.at(-1)!.data as { phase: string }).phase).toBe('stop')
    expect(events.find((e) => e.event === 'prompt_completed')).toMatchObject({
      data: { stopReason: 'cancelled' },
    })
  })

  it('fails the turn and reports an unexpected exit when the process dies', async () => {
    let turn: FakeCodexTurn | undefined
    const { server, runtime, events, exits } = build({ onTurn: (t) => (turn = t) })
    await runtime.start()
    const prompt = runtime.prompt({ prompt: PROMPT })
    await vi.waitFor(() => expect(turn).toBeDefined())
    server.crash({ code: 101, stderr: "thread 'main' panicked at x.rs:1:1:\nboom\n" })
    await expect(prompt).rejects.toThrow()
    await runtime.exited
    expect(events.find((e) => e.event === 'process_exited')).toMatchObject({
      data: { exitCode: 101, expected: false },
    })
    expect(exits).toMatchObject([{ exitCode: 101, expected: false }])
    expect(runtime.phase).toBe('exited')
    await expect(runtime.prompt({ prompt: PROMPT })).rejects.toThrow(/exited/)
  })

  it('stops on request, once, with the first reason', async () => {
    const { runtime, exits, events } = build()
    await runtime.start()
    const [first, second] = await Promise.all([
      runtime.stop({ reason: 'reaped' }),
      runtime.stop({ reason: 'disposed' }),
    ])
    expect(first).toBe(second)
    expect(first).toMatchObject({ expected: true, reason: 'reaped' })
    expect(exits).toHaveLength(1)
    expect(events.find((e) => e.event === 'process_exited')).toMatchObject({
      data: { expected: true },
    })
  })

  it('moves its events to the thread it is rebound to', async () => {
    const { runtime, events } = build()
    runtime.rebindThread('thread-2', 'ws')
    await runtime.start()
    expect(events.every((e) => e.threadId === 'thread-2' && e.workspaceId === 'ws')).toBe(true)
  })
})

describe('CodexSessionRuntime against a recording', () => {
  // The real Codex 0.170, recorded: the runtime sends what Codex was recorded
  // receiving (bar the model catalog, which the recording predates) and
  // handles everything it said back.
  it('runs the recorded simple turn', async () => {
    const server = new ReplayCodexAppServer('simple-turn')
    server.respond('model/list', MODELS as never)
    const { runtime, events } = build({ server })
    await runtime.start()
    await runtime.prompt({ prompt: PROMPT })
    await server.done
    expect(server.unmatched).toEqual([])
    expect(texts(events).length).toBeGreaterThan(0)
    expect(events.find((e) => e.event === 'prompt_completed')).toMatchObject({
      data: { stopReason: 'end_turn' },
    })
    runtime.dispose()
  })
})
