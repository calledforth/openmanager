import { describe, expect, it, vi } from 'vitest'
import type { ToolCall, ToolCallUpdate } from '@agentpack/contract'
import type { BackendEvent } from '../../backends/Backend.js'
import { SessionUnknownError } from '../../core/errors.js'
import { InteractionBroker } from '../../core/InteractionBroker.js'
import { PermissionBroker } from '../../core/PermissionBroker.js'
import { codex } from '../../providers/codex.js'
import type { HostDeps } from '../../host.js'
import type { SessionRuntimeSpec } from '../SessionRuntime.js'
import type { DesiredSessionConfig } from '../lifecycle.js'
import { CodexAppServerClient } from './CodexAppServerClient.js'
import { CodexRpcError } from './CodexRpcPeer.js'
import { CodexSessionRuntime, CodexSteerRefusedError, isArchivedThread } from './CodexSessionRuntime.js'
import type { CodexStarter } from './start.js'
import { codexBuilders, FakeCodexAppServer, type FakeCodexTurn } from './testing/index.js'
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
    controlRequestMs?: number
    sessionHistory?: HostDeps['sessionHistory']
  } = {},
) {
  const server = options.server ?? new FakeCodexAppServer()
  if (!options.server) {
    server.respond('model/list', MODELS as never)
    server.serveThreads(options.onTurn)
  }
  const log = vi.fn()
  const onSessionTitle = vi.fn()
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
      host: {
        log,
        onSessionTitle,
        ...(options.sessionHistory ? { sessionHistory: options.sessionHistory } : {}),
      },
      permissions: new PermissionBroker(),
      interactions: new InteractionBroker(),
      start,
      platform: 'linux',
      timeouts: {
        interruptGraceMs: options.interruptGraceMs ?? 200,
        ...(options.controlRequestMs ? { controlRequestMs: options.controlRequestMs } : {}),
      },
    },
  )
  runtime.events((event) => events.push(event))
  const exits: unknown[] = []
  runtime.onExit((exit) => exits.push(exit))
  return { server, runtime, events, exits, log, onSessionTitle }
}

/** A recording, with the reads a session makes before its thread answered
 * here: the recordings predate them. */
function replay(scenario: ConstructorParameters<typeof ReplayCodexAppServer>[0]): ReplayCodexAppServer {
  const server = new ReplayCodexAppServer(scenario)
  server.respond('model/list', MODELS as never)
  server.respond('configRequirements/read', { requirements: null } as never)
  server.respond('experimentalFeature/list', { data: [], nextCursor: null } as never)
  server.respond('config/read', { config: {}, origins: {}, layers: null } as never)
  server.respond('permissionProfile/list', { data: [], nextCursor: null } as never)
  return server
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
      config: { notify: [], 'tools.update_plan.enabled': true },
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

  // Revert, fork and reconciliation address Codex's turns and items by its
  // own ids: the host is told them as soon as they are known.
  it('reports Codex’s turn id once, early, and each item’s id on its chunks', async () => {
    let turn: FakeCodexTurn | undefined
    const { runtime, events } = build({ onTurn: (t) => (turn = t) })
    await runtime.start()
    const prompt = runtime.prompt({ prompt: PROMPT, userMessageId: 'msg-1' })
    await vi.waitFor(() => expect(turn).toBeDefined())
    // `turn/started` and the `turn/start` response both name it: reported once.
    turn!.started()
    await vi.waitFor(() => expect(names(events)).toContain('turn_identified'))
    const reasoning = turn!.reasoning(['**Planning**'])
    const commentary = turn!.agentMessage('Looking.', { phase: 'commentary' })
    const answer = turn!.agentMessage('Done.', { chunks: ['Do', 'ne.'], phase: 'final_answer' })
    turn!.completed()
    await prompt

    const identified = events.filter((e) => e.event === 'turn_identified')
    expect(identified).toEqual([
      expect.objectContaining({
        category: 'lifecycle',
        sessionId: runtime.sessionId,
        data: { providerTurnId: turn!.id },
      }),
    ])
    const order = names(events)
    expect(order.indexOf('prompt_started')).toBeLessThan(order.indexOf('turn_identified'))
    expect(order.indexOf('turn_identified')).toBeLessThan(order.indexOf('agent_message_chunk'))
    const itemIds = (event: string) =>
      events
        .filter((e) => e.event === event)
        .map((e) => (e.data as { messageId?: string }).messageId)
    expect(new Set(itemIds('agent_thought_chunk'))).toEqual(new Set([reasoning.id]))
    expect(itemIds('agent_message_chunk')).toEqual([commentary.id, answer.id, answer.id])
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

  it('reports the turn’s tools as tool calls, its plan as the checklist, and never a child’s', async () => {
    let turn: FakeCodexTurn | undefined
    const { server, runtime, events } = build({ onTurn: (t) => (turn = t) })
    await runtime.start()
    const prompt = runtime.prompt({ prompt: PROMPT })
    await vi.waitFor(() => expect(turn).toBeDefined())
    turn!.started()
    server.notify('turn/plan/updated', {
      threadId: turn!.threadId,
      turnId: turn!.id,
      explanation: null,
      plan: [{ step: 'Test', status: 'inProgress' }],
    })
    const command = turn!.command('npm test', { chunks: ['ok 1\n', 'ok 2\n'], output: 'ok 1\nok 2\n' })
    turn!.thread.child().turn().started().command('echo from the subagent')
    turn!.completed()
    await prompt

    const tools = events.filter((e) => e.category === 'tool')
    expect(tools.map((e) => e.event)).toEqual([
      'tool_call',
      'tool_call',
      'tool_call_content',
      'tool_call_content',
      'tool_call_update',
    ])
    expect(tools[1]).toMatchObject({
      sessionId: runtime.sessionId,
      data: { toolCallId: command.id, toolName: 'commandExecution', rawInput: { command: 'npm test' } },
    })
    expect(tools.at(-1)).toMatchObject({ data: { status: 'completed', rawInput: { exitCode: 0 } } })
    expect(events.find((e) => e.event === 'plan_update')).toMatchObject({
      category: 'session',
      data: { entries: [{ content: 'Test', status: 'in_progress' }] },
    })
    expect(JSON.stringify(events)).not.toContain('from the subagent')
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

describe('CodexSessionRuntime steer', () => {
  const STEER = { text: 'also this', blocks: [{ type: 'text' as const, text: 'also this' }] }
  const steerEvents = (events: BackendEvent[]) => events.filter((e) => e.event.startsWith('steer_'))

  /** A runtime with a turn running and Codex's id for it known. */
  async function running(options: Parameters<typeof build>[0] = {}) {
    let turn: FakeCodexTurn | undefined
    const built = build({ ...options, onTurn: (t) => (turn = t) })
    await built.runtime.start()
    const prompt = built.runtime.prompt({ prompt: PROMPT, userMessageId: 'msg-1' })
    await vi.waitFor(() => expect(names(built.events)).toContain('turn_identified'))
    turn!.userMessage('hi', { clientId: 'msg-1' })
    return { ...built, turn: turn!, prompt }
  }

  it('sends turn/steer for the running turn and places the message where Codex echoes it', async () => {
    const { server, runtime, events, turn, prompt } = await running()
    const command = turn.commandStarted('sleep 4')

    await runtime.steer({ prompt: STEER, steerId: 'steer-1' })
    const [request] = server.requests('turn/steer')
    expect(request!.params).toEqual({
      threadId: runtime.sessionId,
      expectedTurnId: turn.id,
      clientUserMessageId: 'steer-1',
      input: [{ type: 'text', text: 'also this', text_elements: [] }],
    })
    // No settings ride on a steer: it runs on the turn's own.
    expect(request!.params).not.toHaveProperty('model')
    await vi.waitFor(() => expect(steerEvents(events)).toHaveLength(1))

    turn.commandCompleted(command)
    turn.agentMessage('first second')
    turn.completed()
    await prompt
    expect(steerEvents(events)).toEqual([
      expect.objectContaining({
        category: 'lifecycle',
        event: 'steer_delivered',
        sessionId: runtime.sessionId,
        data: { steerId: 'steer-1' },
      }),
    ])
    // Placed before what the agent said after reading it, inside the turn,
    // and never as a user message of its own (the host shows its copy).
    const order = names(events)
    expect(order.indexOf('steer_delivered')).toBeLessThan(order.indexOf('agent_message_chunk'))
    expect(order.indexOf('steer_delivered')).toBeLessThan(order.indexOf('prompt_completed'))
    expect(order).not.toContain('user_message_chunk')
    expect(order.filter((name) => name === 'prompt_completed')).toHaveLength(1)
  })

  it('places a steer whose echo arrives before Codex answers the request', async () => {
    const { server, runtime, events, turn, prompt } = await running()
    server.respond('turn/steer', (params) => {
      turn.userMessage(params.input, { clientId: params.clientUserMessageId ?? null })
      return { turnId: turn.id }
    })
    await runtime.steer({ prompt: STEER, steerId: 'steer-1' })
    expect(steerEvents(events).map((e) => e.event)).toEqual(['steer_delivered'])
    turn.completed()
    await prompt
  })

  it('waits for Codex to name the turn before steering it', async () => {
    let turn: FakeCodexTurn | undefined
    const { server, runtime, events } = build({ onTurn: (t) => (turn = t) })
    await runtime.start()
    // Steered as soon as the prompt has started, as the host does (a turn of
    // its own is open by then), before `turn/start` has answered.
    let steered: Promise<void> | undefined
    let identifiedFirst: boolean | undefined
    runtime.events((event) => {
      if (event.event !== 'prompt_started') return
      queueMicrotask(() => {
        identifiedFirst = names(events).includes('turn_identified')
        steered = runtime.steer({ prompt: STEER, steerId: 'steer-1' })
      })
    })
    const prompt = runtime.prompt({ prompt: PROMPT })
    await vi.waitFor(() => expect(steered).toBeDefined())
    expect(identifiedFirst).toBe(false)
    await steered
    expect(server.requests('turn/steer')[0]!.params).toMatchObject({ expectedTurnId: turn!.id })
    turn!.completed()
    await prompt
    expect(steerEvents(events).map((e) => e.event)).toEqual(['steer_delivered'])
  })

  // CAL-236's fallback: a refused steer rejects with nothing pending, and the
  // host queues the message for the next turn.
  it('refuses a steer Codex says is for a turn that ended or is another one', async () => {
    const { server, runtime, events, turn, prompt } = await running()
    server.fail('turn/steer', -32600, 'no active turn to steer')
    const refused = runtime.steer({ prompt: STEER, steerId: 'steer-1' })
    await expect(refused).rejects.toBeInstanceOf(CodexSteerRefusedError)
    await expect(refused).rejects.toMatchObject({ reason: 'turn_ended' })
    turn.completed()
    await prompt
    // Its one answer is the rejection: no event, not even at the turn's end.
    expect(steerEvents(events)).toEqual([])
  })

  it('refuses a steer into a turn that cannot be steered (review, compaction)', async () => {
    const { server, runtime, events, turn, prompt } = await running()
    server.fail('turn/steer', -32600, 'cannot steer a review turn', {
      data: { codexErrorInfo: { activeTurnNotSteerable: { turnKind: 'review' } } },
    })
    await expect(runtime.steer({ prompt: STEER, steerId: 'steer-1' })).rejects.toMatchObject({
      reason: 'not_steerable',
    })
    turn.completed()
    await prompt
    expect(steerEvents(events)).toEqual([])
  })

  it('refuses, sending nothing, when no turn runs or the turn is being stopped', async () => {
    const { server, runtime, turn, prompt } = await running()
    server.respond('turn/interrupt', {} as never)
    await runtime.cancel()
    await expect(runtime.steer({ prompt: STEER, steerId: 'steer-1' })).rejects.toMatchObject({
      reason: 'no_turn',
    })
    turn.interrupted()
    await prompt
    await expect(runtime.steer({ prompt: STEER, steerId: 'steer-2' })).rejects.toMatchObject({
      reason: 'no_turn',
    })
    expect(server.requests('turn/steer')).toHaveLength(0)
  })

  it('gives back a steer Codex took but the turn ended without placing', async () => {
    const { server, runtime, events, turn, prompt } = await running()
    server.respond('turn/steer', { turnId: turn.id } as never)
    await runtime.steer({ prompt: STEER, steerId: 'steer-1' })
    turn.interrupted()
    await prompt
    expect(steerEvents(events)).toEqual([
      expect.objectContaining({ event: 'steer_withdrawn', data: { steerId: 'steer-1' } }),
    ])
    const order = names(events)
    expect(order.indexOf('steer_withdrawn')).toBeLessThan(order.indexOf('prompt_completed'))
  })

  it('gives back a steer still unplaced when the process dies', async () => {
    const { server, runtime, events, turn, prompt } = await running()
    server.respond('turn/steer', { turnId: turn.id } as never)
    await runtime.steer({ prompt: STEER, steerId: 'steer-1' })
    server.crash({ code: 1 })
    await expect(prompt).rejects.toThrow()
    expect(steerEvents(events).map((e) => e.event)).toEqual(['steer_withdrawn'])
  })

  // A steer with no answer may be with Codex: refusing it would have the
  // host queue it and run it a second time.
  it('keeps a steer that got no answer pending, and places it at its echo', async () => {
    const { server, runtime, events, turn, prompt, log } = await running({ controlRequestMs: 30 })
    server.respond('turn/steer', () => new Promise<never>(() => undefined))
    await runtime.steer({ prompt: STEER, steerId: 'steer-1' })
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/turn\/steer got no answer/) }),
    )
    expect(steerEvents(events)).toEqual([])
    turn.userMessage('also this', { clientId: 'steer-1' })
    turn.completed()
    await prompt
    expect(steerEvents(events).map((e) => e.event)).toEqual(['steer_delivered'])
  })

  it('gives back a steer that got no answer when the turn ends without its echo', async () => {
    const { server, runtime, events, turn, prompt } = await running({ controlRequestMs: 30 })
    server.respond('turn/steer', () => new Promise<never>(() => undefined))
    await runtime.steer({ prompt: STEER, steerId: 'steer-1' })
    turn.completed()
    await prompt
    expect(steerEvents(events).map((e) => e.event)).toEqual(['steer_withdrawn'])
  })

  // Closing a turn past the interrupt grace, Codex may still hold a steer it
  // has not answered: counted as delivered, never sent twice.
  it('counts a steer still unanswered at a grace close as delivered', async () => {
    const { server, runtime, events, prompt, log } = await running({ interruptGraceMs: 20 })
    server.respond('turn/interrupt', {} as never)
    server.respond('turn/steer', () => new Promise<never>(() => undefined))
    void runtime.steer({ prompt: STEER, steerId: 'steer-1' })
    await vi.waitFor(() => expect(server.requests('turn/steer')).toHaveLength(1))
    await runtime.cancel()
    await prompt
    expect(steerEvents(events).map((e) => e.event)).toEqual(['steer_delivered'])
    const order = names(events)
    expect(order.indexOf('steer_delivered')).toBeLessThan(order.indexOf('prompt_completed'))
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ steerIds: ['steer-1'] }) }),
    )
    runtime.dispose()
  })

  // "Send now" before the steer went out: it is taken back, never sent.
  it('takes back a steer still waiting for Codex to name the turn', async () => {
    let turn: FakeCodexTurn | undefined
    const { server, runtime, events } = build({ onTurn: (t) => (turn = t) })
    await runtime.start()
    let steered: Promise<void> | undefined
    let withdrawn: Promise<boolean> | undefined
    runtime.events((event) => {
      if (event.event !== 'prompt_started') return
      queueMicrotask(() => {
        steered = runtime.steer({ prompt: STEER, steerId: 'steer-1' })
        withdrawn = runtime.withdrawSteer('steer-1')
      })
    })
    const prompt = runtime.prompt({ prompt: PROMPT })
    await vi.waitFor(() => expect(withdrawn).toBeDefined())
    await expect(withdrawn).resolves.toBe(true)
    await expect(runtime.withdrawSteer('steer-1')).resolves.toBe(false)
    await steered
    await vi.waitFor(() => expect(turn).toBeDefined())
    turn!.completed()
    await prompt
    expect(server.requests('turn/steer')).toHaveLength(0)
    expect(steerEvents(events)).toEqual([
      expect.objectContaining({ category: 'lifecycle', event: 'steer_withdrawn', data: { steerId: 'steer-1' } }),
    ])
  })

  // Codex takes a steer while the model is still writing; the host starts a
  // new run of text after a delivered steer, so delivery waits for the
  // message to complete rather than split it.
  it('places a steer echoed mid-message after that message', async () => {
    const { server, runtime, events, turn, prompt } = await running()
    const item = codexBuilders.agentMessageItem('Looking into it.', { phase: 'commentary' })
    turn.itemStarted({ ...item, text: '' })
    const delta = (text: string) =>
      server.notify('item/agentMessage/delta', {
        threadId: turn.threadId,
        turnId: turn.id,
        itemId: item.id,
        delta: text,
      })
    delta('Looking ')
    await runtime.steer({ prompt: STEER, steerId: 'steer-1' })
    delta('into it.')
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(steerEvents(events)).toEqual([])
    turn.itemCompleted(item)
    turn.completed()
    await prompt
    const order = names(events)
    expect(order.lastIndexOf('agent_message_chunk')).toBeLessThan(order.indexOf('steer_delivered'))
    expect(texts(events)).toBe('Looking into it.')
  })

  // Codex has no un-steer: what was sent stays sent.
  it('never takes a steer back', async () => {
    const { runtime, turn, prompt } = await running()
    await runtime.steer({ prompt: STEER, steerId: 'steer-1' })
    await expect(runtime.withdrawSteer('steer-1')).resolves.toBe(false)
    await expect(runtime.withdrawSteer('unknown')).resolves.toBe(false)
    turn.completed()
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

/** Answer `thread/name/set` the way Codex 0.170 does: `{}`, and the new name
 * echoed back as `thread/name/updated` on the same connection, here before
 * the answer or after it. */
function echoNames(server: FakeCodexAppServer, order: 'before' | 'after' = 'after') {
  const echo = (params: { threadId: string; name: string }) =>
    server.notify('thread/name/updated', { threadId: params.threadId, threadName: params.name })
  if (order === 'before')
    server.respond('thread/name/set', (params) => {
      echo(params)
      return {}
    })
  else server.respond('thread/name/set', {}, { after: (request) => echo(request.params) })
}

const titles = (events: BackendEvent[]) =>
  events
    .filter((e) => e.event === 'session_info_update')
    .map((e) => (e.data as { title: string }).title)

const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

describe('CodexSessionRuntime name and archive', () => {
  it('names a new thread with the session title once it is open, and drops the echo', async () => {
    const { server, runtime, events, onSessionTitle } = build({
      spec: { title: 'Fix the login bug' },
    })
    echoNames(server)
    const { sessionId } = await runtime.start()

    const request = await server.nextRequest('thread/name/set')
    expect(request.params).toEqual({ threadId: sessionId, name: 'Fix the login bug' })
    await settle()
    expect(titles(events)).toEqual([])
    expect(onSessionTitle).not.toHaveBeenCalled()
  })

  it('renames a live thread, and takes a name Codex gives it as the agent’s title', async () => {
    const { server, runtime, events, onSessionTitle } = build()
    echoNames(server, 'before')
    const { sessionId } = await runtime.start()
    expect(server.requests('thread/name/set')).toHaveLength(0)

    await runtime.setTitle('Renamed by the user')
    expect(server.requests('thread/name/set')[0]!.params).toEqual({
      threadId: sessionId,
      name: 'Renamed by the user',
    })
    // The same title again is not sent again.
    await runtime.setTitle('Renamed by the user')
    expect(server.requests('thread/name/set')).toHaveLength(1)

    server.notify('thread/name/updated', { threadId: sessionId!, threadName: 'Codex’s own name' })
    await vi.waitFor(() => expect(titles(events)).toEqual(['Codex’s own name']))
    expect(onSessionTitle).toHaveBeenCalledWith({
      threadId: 'thread-1',
      workspaceId: undefined,
      title: 'Codex’s own name',
    })
  })

  it('names the thread with a title set before it was open', async () => {
    const { server, runtime } = build()
    echoNames(server)
    await runtime.setTitle('Set while starting')
    expect(server.requests('thread/name/set')).toHaveLength(0)
    await runtime.start()
    const request = await server.nextRequest('thread/name/set')
    expect(request.params.name).toBe('Set while starting')
  })

  it('takes a name Codex changed on the way in, while its set is unanswered, as the echo', async () => {
    const { server, runtime, events } = build()
    // Codex answers with the name it stored, not the one it was sent.
    server.respond('thread/name/set', (params) => {
      server.notify('thread/name/updated', {
        threadId: params.threadId,
        threadName: `${params.name.slice(0, 5)}…`,
      })
      return {}
    })
    await runtime.start()
    await runtime.setTitle('A long session title')
    await settle()
    expect(titles(events)).toEqual([])
  })

  it('tries a refused name again after the next turn', async () => {
    let turn: FakeCodexTurn | undefined
    const { server, runtime } = build({ onTurn: (t) => (turn = t) })
    server.respond('thread/name/set', {})
    server.fail('thread/name/set', -32603, 'database is locked', { times: 1 })
    const { sessionId } = await runtime.start()
    await runtime.setTitle('Retried title')
    expect(server.requests('thread/name/set')).toHaveLength(1)

    const prompt = runtime.prompt({ prompt: PROMPT })
    await vi.waitFor(() => expect(turn).toBeDefined())
    turn!.completed()
    await prompt
    await vi.waitFor(() => expect(server.requests('thread/name/set')).toHaveLength(2))
    expect(server.requests('thread/name/set')[1]!.params).toEqual({
      threadId: sessionId,
      name: 'Retried title',
    })
  })

  it('never fails over a name Codex refuses', async () => {
    const { server, runtime, events, log } = build()
    server.fail('thread/name/set', -32600, 'no rollout found for thread id x')
    await runtime.start()
    await expect(runtime.setTitle('A title')).resolves.toBeUndefined()
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ level: 'warn', scope: 'codex' }))
    expect(titles(events)).toEqual([])
  })

  it('on resume, leaves a thread that has the title alone and renames one that does not', async () => {
    // One app-server per runtime, as in production.
    const resuming = () => {
      const server = new FakeCodexAppServer()
      server.respond('model/list', MODELS as never)
      echoNames(server)
      const thread = server.thread({ id: 'stored', name: 'Same title' })
      server.respond('thread/resume', thread.startResponse() as never)
      return server
    }
    const sameServer = resuming()
    const same = build({ server: sameServer, spec: { sessionId: 'stored', title: 'Same title' } })
    await same.runtime.start()
    await settle()
    expect(sameServer.requests('thread/name/set')).toHaveLength(0)
    expect(titles(same.events)).toEqual([])

    const otherServer = resuming()
    const other = build({ server: otherServer, spec: { sessionId: 'stored', title: 'Ours wins' } })
    await other.runtime.start()
    const request = await otherServer.nextRequest('thread/name/set')
    expect(request.params).toEqual({ threadId: 'stored', name: 'Ours wins' })
    await settle()
    expect(titles(other.events)).toEqual([])
  })

  it('on resume without a title of ours, reports the name the thread has as the agent’s title', async () => {
    const server = new FakeCodexAppServer()
    server.respond('model/list', MODELS as never)
    const thread = server.thread({ id: 'stored', name: 'Named in Codex' })
    server.respond('thread/resume', thread.startResponse() as never)
    const { runtime, events } = build({ server, spec: { sessionId: 'stored' } })
    await runtime.start()
    expect(titles(events)).toEqual(['Named in Codex'])
    expect(server.requests('thread/name/set')).toHaveLength(0)
  })

  it('unarchives a thread archived outside openmanager, then resumes it', async () => {
    const server = new FakeCodexAppServer()
    server.respond('model/list', MODELS as never)
    const thread = server.thread({ id: 'stored' })
    server.respond('thread/resume', thread.startResponse() as never)
    server.fail(
      'thread/resume',
      -32600,
      'session stored is archived. Run `codex unarchive stored` to unarchive it first.',
      { times: 1 },
    )
    server.respond('thread/unarchive', { thread: thread.thread })
    const { runtime } = build({ server, spec: { sessionId: 'stored' } })

    await expect(runtime.start()).resolves.toMatchObject({ sessionId: 'stored', state: 'loaded' })
    expect(server.requests('thread/unarchive')[0]!.params).toEqual({ threadId: 'stored' })
    expect(server.requests('thread/resume')).toHaveLength(2)
    expect(server.requests('thread/start')).toHaveLength(0)
  })

  it('archives its own thread, and takes a thread Codex no longer has as archived', async () => {
    const { server, runtime } = build()
    server.respond('thread/archive', {})
    const { sessionId } = await runtime.start()
    await runtime.archive()
    expect(server.requests('thread/archive')[0]!.params).toEqual({ threadId: sessionId })

    server.fail('thread/archive', -32600, `no rollout found for thread id ${sessionId}`)
    await expect(runtime.archive()).resolves.toBeUndefined()
    server.fail('thread/archive', -32600, `thread ${sessionId} already has an active writer`)
    await expect(runtime.archive()).rejects.toThrow(/active writer/)
  })

  it('tells an archived thread by its code as well as its message', () => {
    const message = 'session x is archived. Run `codex unarchive x` to unarchive it first.'
    expect(isArchivedThread(new CodexRpcError(-32600, message))).toBe(true)
    expect(isArchivedThread(new CodexRpcError(-32603, message))).toBe(false)
  })
})

describe('CodexSessionRuntime against a recording', () => {
  // The real Codex 0.170, recorded: the runtime sends what Codex was recorded
  // receiving (bar the model catalog, which the recording predates) and
  // handles everything it said back.
  it('runs the recorded simple turn', async () => {
    const server = replay('simple-turn')
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

  // A read, a search, a listing, a failing listing and an edit, with the plan
  // before and after: what the real Codex says about them, as tool calls.
  it('reports the recorded tools as tool calls', async () => {
    const server = new ReplayCodexAppServer('tool-items')
    server.respond('model/list', MODELS as never)
    const { runtime, events } = build({ server })
    await runtime.start()
    await runtime.prompt({ prompt: PROMPT })
    await server.done
    expect(server.unmatched).toEqual([])
    const calls = events.filter((e) => e.event === 'tool_call').map((e) => e.data as ToolCall)
    expect(calls.map((call) => [call.toolName, call.kind])).toEqual([
      ['update_plan', 'think'],
      ['commandExecution', 'read'],
      ['commandExecution', 'search'],
      ['commandExecution', 'search'],
      ['commandExecution', 'search'],
      ['fileChange', 'edit'],
      ['update_plan', 'think'],
    ])
    expect(calls.slice(1, 5).map((call) => (call.rawInput as { command: string }).command)).toEqual([
      'cat notes.txt',
      'rg -n hello',
      'ls',
      'ls does-not-exist',
    ])
    const settled = events.filter((e) => e.event === 'tool_call_update').map((e) => e.data as ToolCallUpdate)
    expect(settled.map((update) => update.status)).toEqual(['completed', 'completed', 'completed', 'failed', 'completed'])
    expect(settled[3]).toMatchObject({ rawInput: { exitCode: 2 } })
    expect(settled[4]).toMatchObject({
      locations: [{ path: '/workspace/notes.txt' }],
      lineChanges: { added: 1, removed: 1 },
    })
    expect(events.filter((e) => e.event === 'plan_update').map((e) => e.data)).toEqual([
      {
        entries: [
          { content: 'Look around', priority: 'medium', status: 'in_progress' },
          { content: 'Edit notes', priority: 'medium', status: 'pending' },
        ],
      },
      {
        entries: [
          { content: 'Look around', priority: 'medium', status: 'completed' },
          { content: 'Edit notes', priority: 'medium', status: 'completed' },
        ],
      },
    ])
    runtime.dispose()
  })

  it('shows what the recorded write_stdin sent on the command it went to', async () => {
    const server = new ReplayCodexAppServer('terminal-interaction')
    server.respond('model/list', MODELS as never)
    const { runtime, events } = build({ server })
    await runtime.start()
    await runtime.prompt({ prompt: PROMPT })
    await server.done
    const updates = events.filter((e) => e.event === 'tool_call_update').map((e) => e.data as ToolCallUpdate)
    expect(updates[0]).toMatchObject({ rawInput: { stdin: ['ada\n'] } })
    expect(updates.at(-1)).toMatchObject({ status: 'completed', rawInput: { stdin: ['ada\n'], exitCode: 0 } })
    runtime.dispose()
  })

  it('steers the recorded turn and places the message where Codex echoed it', async () => {
    const server = replay('steer')
    const { runtime, events } = build({ server })
    await runtime.start()
    const prompt = runtime.prompt({ prompt: PROMPT })
    // The recording steered while its `sleep 4` ran.
    await vi.waitFor(() => expect(server.waitingFor).toMatchObject({ method: 'turn/steer' }))
    await runtime.steer({
      prompt: { text: 'Also add the word "second" to your reply.', blocks: [] },
      steerId: 'steer-1',
    })
    await prompt
    await server.done
    server.assertPlayedAsRecorded()
    const turnId = (events.find((e) => e.event === 'turn_identified')!.data as { providerTurnId: string })
      .providerTurnId
    const steer = server.matched.find((m) => 'method' in m.actual && m.actual.method === 'turn/steer')
    expect(steer!.actual).toMatchObject({ params: { expectedTurnId: turnId, clientUserMessageId: 'steer-1' } })
    // Recorded without client ids: the echo is known by its words, and the
    // prompt's echo is not taken for it.
    expect(events.filter((e) => e.event.startsWith('steer_'))).toEqual([
      expect.objectContaining({ event: 'steer_delivered', data: { steerId: 'steer-1' } }),
    ])
    expect(texts(events)).toBe('first second')
    expect(events.filter((e) => e.event === 'prompt_completed')).toHaveLength(1)
    runtime.dispose()
  })
})

describe('CodexSessionRuntime review regressions', () => {
  // A session deleted or moved while its process starts must not leave a
  // `codex app-server` running with nobody to stop it.
  it('stops a process that finishes starting after the runtime was stopped', async () => {
    const server = new FakeCodexAppServer()
    server.respond('model/list', MODELS as never).serveThreads()
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    const events: BackendEvent[] = []
    const runtime = new CodexSessionRuntime(
      { threadId: 't', providerId: 'codex', cwd: '/work' },
      {
        config: codex,
        host: { log: vi.fn() },
        permissions: new PermissionBroker(),
        interactions: new InteractionBroker(),
        platform: 'linux',
        start: async () => {
          await gate
          const client = new CodexAppServerClient(server, {
            log: vi.fn(),
            terminateGraceMs: 50,
            requestTimeoutMs: 2_000,
            exitDrainMs: 10,
          })
          await client.initialize({ clientVersion: 't' })
          return client
        },
      },
    )
    runtime.events((event) => events.push(event))
    const starting = runtime.start()
    await runtime.stop({ reason: 'disposed' })
    release()
    await expect(starting).rejects.toThrow()
    await vi.waitFor(() => expect(server.exited).toBe(true))
    expect(names(events)).not.toContain('session_created')
  })

  // After a cancel closed a turn itself, that turn's late completion must not
  // be taken for the next prompt's turn.
  // Review: after a grace close Codex may still run the turn, so the next
  // `turn/start` would land on a busy thread; the process is replaced.
  it('replaces the process after closing a turn Codex did not finish', async () => {
    const turns: FakeCodexTurn[] = []
    const { server, runtime, events } = build({ onTurn: (t) => turns.push(t), interruptGraceMs: 10 })
    server.respond('turn/interrupt', () => new Promise(() => undefined) as never)
    await runtime.start()
    const first = runtime.prompt({ prompt: PROMPT })
    await vi.waitFor(() => expect(turns).toHaveLength(1))
    await runtime.cancel()
    await first
    expect(events.find((e) => e.event === 'prompt_completed')).toMatchObject({
      data: { stopReason: 'cancelled' },
    })
    await runtime.exited
    expect(runtime.exit).toMatchObject({ expected: true, reason: 'restart' })
    expect(server.exited).toBe(true)
    // A steer for it is refused as having no turn, not as an error.
    await expect(runtime.steer({ prompt: PROMPT, steerId: 's' })).rejects.toMatchObject({
      reason: 'no_turn',
    })
  })

  // Review: a `turn/start` that times out may leave Codex running a turn it
  // never names to us. Guessing which later turn is that one hijacked the
  // next prompt; the process is replaced instead, so that turn dies with it.
  it('replaces the process when a turn/start never answers', async () => {
    const { server, runtime, exits } = build({ controlRequestMs: 50 })
    await runtime.start()
    server.respond('turn/start', () => new Promise(() => undefined) as never, { times: 1 })
    await expect(runtime.prompt({ prompt: PROMPT })).rejects.toThrow(/did not answer/)
    await runtime.exited
    expect(exits).toMatchObject([{ reason: 'restart', expected: true }])
    expect(server.requests('turn/interrupt')).toHaveLength(0)
  })

  // A `turn/start` Codex refuses started nothing: the process stays.
  it('keeps the process when Codex refuses a turn/start', async () => {
    const { server, runtime } = build()
    await runtime.start()
    server.fail('turn/start', -32600, 'nope', { times: 1 })
    await expect(runtime.prompt({ prompt: PROMPT })).rejects.toThrow(/nope/)
    expect(runtime.phase).toBe('ready')
  })

  it('blocks and interrupts a turn Codex names only after a grace close', async () => {
    const { server, runtime } = build({ interruptGraceMs: 10 })
    await runtime.start()
    const thread = server.thread({ id: runtime.sessionId! } as never)
    const orphan = thread.turn()
    let answer: (value: unknown) => void = () => undefined
    server.respond('turn/start', () => new Promise((resolve) => (answer = resolve)) as never, { times: 1 })
    const first = runtime.prompt({ prompt: PROMPT })
    await vi.waitFor(() => expect(server.requests('turn/start')).toHaveLength(1))
    // Closed while still unnamed; the runtime is replaced, so the late answer
    // finds no process to run on. Nothing of it reaches anyone.
    await runtime.cancel()
    await first
    answer(orphan.startResponse())
    await runtime.exited
    expect(runtime.exit).toMatchObject({ reason: 'restart' })
  })

  // Codex answers `turn/interrupt` only once the turn has stopped; cancel
  // must not wait on that answer before its own grace.
  it('closes the turn after the grace even when the interrupt never answers', async () => {
    let turn: FakeCodexTurn | undefined
    const { server, runtime, events } = build({ onTurn: (t) => (turn = t), interruptGraceMs: 20 })
    server.respond('turn/interrupt', () => new Promise(() => undefined) as never)
    await runtime.start()
    const prompt = runtime.prompt({ prompt: PROMPT })
    await vi.waitFor(() => expect(turn).toBeDefined())
    const started = Date.now()
    await runtime.cancel()
    await prompt
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(events.find((e) => e.event === 'prompt_completed')).toMatchObject({
      data: { stopReason: 'cancelled' },
    })
  })

  it('sends turn/interrupt once however many times it is cancelled', async () => {
    let turn: FakeCodexTurn | undefined
    const { server, runtime } = build({ onTurn: (t) => (turn = t), interruptGraceMs: 20 })
    server.respond('turn/interrupt', {} as never)
    await runtime.start()
    const prompt = runtime.prompt({ prompt: PROMPT })
    await vi.waitFor(() => expect(turn).toBeDefined())
    await Promise.all([runtime.cancel(), runtime.cancel()])
    await prompt
    expect(server.requests('turn/interrupt')).toHaveLength(1)
  })

  it('does not start a process just to cancel nothing', async () => {
    const { server, runtime } = build()
    await runtime.cancel()
    expect(server.requests('thread/start')).toHaveLength(0)
    expect(runtime.phase).toBe('created')
  })

  // Usage is the turn's, across every request a tool loop makes.
  it('reports the whole turn’s tokens, not just the last request’s', async () => {
    let turn: FakeCodexTurn | undefined
    const { runtime, events } = build({ onTurn: (t) => (turn = t) })
    await runtime.start()
    const prompt = runtime.prompt({ prompt: PROMPT })
    await vi.waitFor(() => expect(turn).toBeDefined())
    // History before this process: 1000 tokens. Two requests this turn.
    turn!.tokenUsage({ totalTokens: 100, inputTokens: 90, outputTokens: 10 }, {
      totalTokens: 1100,
      inputTokens: 1000,
      outputTokens: 100,
    })
    turn!.tokenUsage({ totalTokens: 60, inputTokens: 50, outputTokens: 10 }, {
      totalTokens: 1160,
      inputTokens: 1050,
      outputTokens: 110,
    })
    turn!.completed()
    await prompt
    expect(events.find((e) => e.event === 'prompt_completed')).toMatchObject({
      data: { usage: { totalTokens: 160, inputTokens: 140, outputTokens: 20 } },
    })
  })
})

describe('CodexSessionRuntime, final review', () => {
  // Review: these got -32601, whose effect on a turn is unprobed.
  it('declines permission, question and elicitation requests outright', async () => {
    const { server, runtime } = build()
    const { sessionId } = await runtime.start()
    const context = { threadId: sessionId, turnId: 'turn-1', itemId: 'item-1' }
    const permissions = server.request(
      'item/permissions/requestApproval',
      codexBuilders.permissionsApprovalParams(context),
    )
    const question = server.request('item/tool/requestUserInput', codexBuilders.userInputParams(context))
    const elicitation = server.request(
      'mcpServer/elicitation/request',
      codexBuilders.elicitationParams(context as never),
    )
    await expect(permissions.answered).resolves.toMatchObject({
      result: { permissions: {}, scope: 'turn' },
    })
    await expect(question.answered).resolves.toMatchObject({ result: { answers: {} } })
    await expect(elicitation.answered).resolves.toMatchObject({
      result: { action: 'decline', content: null },
    })
  })

  // Review: the finished-turn ids grew for the runtime's whole life.
  it('remembers only the last finished turns', async () => {
    const turns: FakeCodexTurn[] = []
    const { runtime } = build({ onTurn: (t) => turns.push(t) })
    await runtime.start()
    for (let index = 0; index < 70; index++) {
      const prompt = runtime.prompt({ prompt: PROMPT })
      await vi.waitFor(() => expect(turns).toHaveLength(index + 1))
      turns[index]!.completed()
      await prompt
    }
    const finished = (runtime as unknown as { finishedTurnIds: Set<string> }).finishedTurnIds
    expect(finished.size).toBe(64)
    expect(finished.has(turns[69]!.id)).toBe(true)
    expect(finished.has(turns[0]!.id)).toBe(false)
  })

  // Review: an echo that never came was waited for forever.
  it('forgets name echoes still owed when the next turn starts', async () => {
    const turns: FakeCodexTurn[] = []
    const { server, runtime } = build({ onTurn: (t) => turns.push(t) })
    server.respond('thread/name/set', {}) // answered, never echoed
    await runtime.start()
    await runtime.setTitle('A title')
    const echoes = (runtime as unknown as { nameEchoes: Map<string, number> }).nameEchoes
    expect(echoes.size).toBe(1)
    const prompt = runtime.prompt({ prompt: PROMPT })
    await vi.waitFor(() => expect(turns).toHaveLength(1))
    expect(echoes.size).toBe(0)
    turns[0]!.completed()
    await prompt
  })
})

/** Serve a thread Codex already has (`thread/resume`), and turns on it. */
function serveStored(
  server: FakeCodexAppServer,
  id: string,
  onTurn?: (turn: FakeCodexTurn) => void,
) {
  const thread = server.thread({ id })
  server.respond('thread/resume', thread.startResponse() as never)
  let last: FakeCodexTurn | undefined
  server.respond(
    'turn/start',
    (params) => {
      if (params.threadId !== id) throw new CodexRpcError(-32600, `thread not found: ${params.threadId}`)
      last = thread.turn()
      return last.startResponse()
    },
    {
      after: () => {
        last!.started()
        onTurn?.(last!)
      },
    },
  )
  return thread
}

const notices = (events: BackendEvent[]) =>
  events
    .filter((e) => e.event === 'provider_notice')
    .map((e) => e.data as { kind: string; message: string })

describe('CodexSessionRuntime consistency (CAL-254)', () => {
  it('hands a fresh thread the conversation a missing one held, and says so in the next turn', async () => {
    const server = new FakeCodexAppServer()
    server.respond('model/list', MODELS as never).serveThreads((t) => t.completed())
    server.fail('thread/resume', -32600, 'no rollout found for thread id gone')
    server.respond('thread/inject_items', {})
    const sessionHistory = vi.fn(() => [
      { messageId: 'm1', role: 'user' as const, text: 'Remember the number 7' },
      { messageId: 'm2', role: 'assistant' as const, text: 'Noted: 7.' },
      { messageId: 'msg-now', role: 'user' as const, text: 'What was it?' },
    ])
    const { runtime, events } = build({ server, spec: { sessionId: 'gone' }, sessionHistory })
    const { sessionId } = await runtime.start()
    await runtime.prompt({ prompt: PROMPT, userMessageId: 'msg-now' })

    expect(sessionHistory).toHaveBeenCalledWith({ providerId: 'codex', threadId: 'thread-1' })
    // The prompt about to run is not history.
    expect(server.requests('thread/inject_items')[0]!.params).toEqual({
      threadId: sessionId,
      items: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Remember the number 7' }] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Noted: 7.' }] },
      ],
    })
    const order = names(events)
    expect(order.indexOf('prompt_started')).toBeLessThan(order.indexOf('provider_notice'))
    expect(notices(events)).toEqual([
      expect.objectContaining({ kind: 'warning', message: expect.stringMatching(/passed on/) }),
    ])
    // Once only.
    await runtime.prompt({ prompt: PROMPT })
    expect(server.requests('thread/inject_items')).toHaveLength(1)
    expect(notices(events)).toHaveLength(1)
  })

  it('says the context was lost when Codex refuses the earlier messages', async () => {
    const server = new FakeCodexAppServer()
    server.respond('model/list', MODELS as never).serveThreads((t) => t.completed())
    server.fail('thread/resume', -32600, 'no rollout found for thread id gone')
    server.fail('thread/inject_items', -32601, 'method not found')
    const { runtime, events } = build({
      server,
      spec: { sessionId: 'gone' },
      sessionHistory: () => [{ messageId: 'm1', role: 'user', text: 'Earlier' }],
    })
    await runtime.start()
    await runtime.prompt({ prompt: PROMPT })
    expect(notices(events)).toEqual([
      expect.objectContaining({ message: expect.stringMatching(/without the earlier context/) }),
    ])
  })

  it('says nothing about lost context when there was none', async () => {
    const server = new FakeCodexAppServer()
    server.respond('model/list', MODELS as never).serveThreads((t) => t.completed())
    server.fail('thread/resume', -32600, 'no rollout found for thread id gone')
    const { runtime, events } = build({
      server,
      spec: { sessionId: 'gone' },
      // Only the prompt about to run.
      sessionHistory: () => [{ messageId: 'msg-now', role: 'user', text: 'First words' }],
    })
    await runtime.start()
    await runtime.prompt({ prompt: PROMPT, userMessageId: 'msg-now' })
    expect(server.requests('thread/inject_items')).toHaveLength(0)
    expect(notices(events)).toEqual([])
  })

  it('counts a fresh thread’s tokens from zero after replacing a deleted one', async () => {
    let turn: FakeCodexTurn | undefined
    const { server, runtime, events } = build({ onTurn: (t) => (turn = t) })
    const { sessionId } = await runtime.start()
    let prompt = runtime.prompt({ prompt: PROMPT })
    await vi.waitFor(() => expect(turn).toBeDefined())
    turn!.tokenUsage({ totalTokens: 500 }, { totalTokens: 5_000 })
    turn!.completed()
    await prompt
    server.fail('thread/resume', -32600, `no rollout found for thread id ${sessionId}`)
    server.notify('thread/deleted', { threadId: sessionId })
    await settle()
    turn = undefined
    prompt = runtime.prompt({ prompt: PROMPT })
    await vi.waitFor(() => expect(turn).toBeDefined())
    turn!.tokenUsage({ totalTokens: 120 }, { totalTokens: 120 })
    turn!.completed()
    await prompt
    expect(events.filter((e) => e.event === 'prompt_completed').at(-1)).toMatchObject({
      data: { usage: { totalTokens: 120 } },
    })
  })

  it('shows an outside archive, and unarchives and resumes the thread before the next turn', async () => {
    const { server, runtime, events } = build({ onTurn: (t) => t.completed() })
    const { sessionId } = await runtime.start()
    const thread = server.thread({ id: sessionId })
    server.respond('thread/resume', thread.startResponse() as never)
    server.fail('thread/resume', -32600, `session ${sessionId} is archived. Run \`codex unarchive\``, {
      times: 1,
    })
    server.respond('thread/unarchive', { thread: thread.thread }, {
      after: () => server.notify('thread/unarchived', { threadId: sessionId }),
    })

    server.notify('thread/archived', { threadId: sessionId })
    await settle()
    // Nothing runs, so the notice waits for the next turn.
    expect(notices(events)).toEqual([])
    await runtime.prompt({ prompt: PROMPT })

    expect(server.requests('thread/unarchive')).toHaveLength(1)
    expect(server.requests('thread/resume')).toHaveLength(2)
    expect(runtime.sessionId).toBe(sessionId)
    // Our own unarchive is not reported as an outside one.
    expect(notices(events)).toEqual([expect.objectContaining({ message: expect.stringMatching(/archived in Codex/) })])
    expect(names(events)).toContain('prompt_completed')
  })

  it('fails a turn Codex closes outside openmanager, and reopens the thread for the next one', async () => {
    let turn: FakeCodexTurn | undefined
    const { server, runtime, events } = build({ onTurn: (t) => (turn = t) })
    const { sessionId } = await runtime.start()
    const prompt = runtime.prompt({ prompt: PROMPT })
    await vi.waitFor(() => expect(turn).toBeDefined())
    server.notify('thread/closed', { threadId: sessionId })
    await expect(prompt).rejects.toThrow(/closed/)
    expect(events.find((e) => e.event === 'runtime_error')).toMatchObject({
      data: { kind: 'provider', problem: { code: 'unknown', action: 'retry' } },
    })
    expect(notices(events)).toEqual([expect.objectContaining({ message: expect.stringMatching(/closed/) })])

    turn = undefined
    server.respond('thread/resume', server.thread({ id: sessionId }).startResponse() as never)
    const next = runtime.prompt({ prompt: PROMPT })
    await vi.waitFor(() => expect(turn).toBeDefined())
    turn!.completed()
    await next
    expect(server.requests('thread/resume')[0]!.params).toMatchObject({ threadId: sessionId })
  })

  it('replaces a thread deleted outside openmanager with a fresh one, re-stamped and handed over', async () => {
    const { server, runtime, events } = build({
      onTurn: (t) => t.completed(),
      sessionHistory: () => [{ messageId: 'm1', role: 'user', text: 'Earlier' }],
    })
    const { sessionId } = await runtime.start()
    server.fail('thread/resume', -32600, `no rollout found for thread id ${sessionId}`)
    server.respond('thread/inject_items', {})
    server.notify('thread/deleted', { threadId: sessionId })
    await settle()
    await runtime.prompt({ prompt: PROMPT })

    expect(runtime.sessionId).not.toBe(sessionId)
    const created = events.filter((e) => e.event === 'session_created')
    expect(created.at(-1)).toMatchObject({ sessionId: runtime.sessionId })
    // Stamped before the turn is sent.
    expect(names(events).lastIndexOf('session_created')).toBeLessThan(names(events).indexOf('prompt_started'))
    expect(server.requests('thread/inject_items')[0]!.params).toMatchObject({ threadId: runtime.sessionId })
    expect(server.requests('turn/start').at(-1)!.params).toMatchObject({ threadId: runtime.sessionId })
    expect(notices(events).map((n) => n.message)).toEqual([
      expect.stringMatching(/deleted in Codex/),
      expect.stringMatching(/passed on/),
    ])
  })

  it('does not take its own archive for an outside one', async () => {
    const { server, runtime, events } = build({ onTurn: (t) => t.completed() })
    const { sessionId } = await runtime.start()
    server.respond('thread/archive', {}, {
      after: () => {
        server.notify('thread/archived', { threadId: sessionId })
        server.notify('thread/closed', { threadId: sessionId })
      },
    })
    await runtime.archive()
    await settle()
    await runtime.prompt({ prompt: PROMPT })
    expect(notices(events)).toEqual([])
    expect(server.requests('thread/resume')).toHaveLength(0)
  })

  it('shows a system error on the thread, and reopens it unless Codex says it recovered', async () => {
    const { server, runtime, events } = build({ onTurn: (t) => t.completed() })
    const { sessionId } = await runtime.start()
    const thread = server.thread({ id: sessionId })
    server.respond('thread/resume', thread.startResponse() as never)
    thread.status({ type: 'systemError' })
    await settle()
    await runtime.prompt({ prompt: PROMPT })
    expect(notices(events)).toEqual([expect.objectContaining({ message: expect.stringMatching(/system error/) })])
    expect(server.requests('thread/resume')).toHaveLength(1)

    thread.status({ type: 'systemError' })
    thread.status({ type: 'idle' })
    await settle()
    await runtime.prompt({ prompt: PROMPT })
    expect(server.requests('thread/resume')).toHaveLength(1)
  })

  it('shows a rewind made outside openmanager without touching the history', async () => {
    const { server, runtime, events, log } = build({ onTurn: (t) => t.completed() })
    const { sessionId } = await runtime.start()
    server.notify('thread/reverted', { threadId: sessionId })
    await settle()
    await runtime.prompt({ prompt: PROMPT })
    expect(notices(events)).toEqual([expect.objectContaining({ message: expect.stringMatching(/rewound/) })])
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/not reconciled/) }))
  })

  it('reports Codex’s retries as recoverable, with how far through them it is', async () => {
    let turn: FakeCodexTurn | undefined
    const { server, runtime, events } = build({ onTurn: (t) => (turn = t) })
    const { sessionId } = await runtime.start()
    const prompt = runtime.prompt({ prompt: PROMPT })
    await vi.waitFor(() => expect(turn).toBeDefined())
    server.notify('error', {
      threadId: sessionId,
      turnId: turn!.id,
      willRetry: true,
      error: {
        message: 'Reconnecting... 2/5',
        codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } },
        additionalDetails: null,
        misalignment: null,
      },
    })
    turn!.agentMessage('Back.')
    turn!.completed()
    await prompt
    expect(events.find((e) => e.event === 'rpc_error')).toMatchObject({
      data: { recoverable: true, problem: { code: 'network', retry: { attempt: 2, maxAttempts: 5 } } },
    })
    expect(names(events)).toContain('prompt_completed')
  })

  it('types a failed turn from its codexErrorInfo', async () => {
    const { runtime, events } = build({
      onTurn: (t) => t.failed('You have hit your usage limit', 'usageLimitExceeded'),
    })
    await runtime.start()
    await expect(runtime.prompt({ prompt: PROMPT })).rejects.toThrow(/usage limit/)
    expect(events.find((e) => e.event === 'runtime_error')).toMatchObject({
      data: {
        kind: 'provider',
        problem: { code: 'usage_limit', detail: 'You have hit your usage limit' },
      },
    })
  })

  it('types a failure Codex reported before the turn ended', async () => {
    let turn: FakeCodexTurn | undefined
    const { server, runtime, events } = build({ onTurn: (t) => (turn = t) })
    const { sessionId } = await runtime.start()
    const prompt = runtime.prompt({ prompt: PROMPT })
    await vi.waitFor(() => expect(turn).toBeDefined())
    server.notify('error', {
      threadId: sessionId,
      turnId: turn!.id,
      willRetry: false,
      error: {
        message: 'Context full',
        codexErrorInfo: 'contextWindowExceeded',
        additionalDetails: null,
        misalignment: null,
      },
    })
    turn!.completed({ status: 'failed' })
    await expect(prompt).rejects.toThrow(/Context full/)
    expect(events.find((e) => e.event === 'runtime_error')).toMatchObject({
      data: { problem: { code: 'context_window_exceeded' } },
    })
  })

  it('shows warnings said before a turn at its start, and a reroute inside it', async () => {
    let turn: FakeCodexTurn | undefined
    const { server, runtime, events } = build({ onTurn: (t) => (turn = t) })
    const { sessionId } = await runtime.start()
    server.notify('configWarning', { summary: 'bubblewrap not found', details: null })
    server.notify('mcpServer/startupStatus/updated', {
      threadId: sessionId,
      name: 'linear',
      status: 'failed',
      error: 'boom',
      failureReason: null,
    })
    server.notify('deprecationNotice', { summary: 'Old flag', details: null })
    // Said twice, kept once.
    server.notify('configWarning', { summary: 'bubblewrap not found', details: null })
    await settle()
    expect(notices(events)).toEqual([])
    const prompt = runtime.prompt({ prompt: PROMPT })
    await vi.waitFor(() => expect(turn).toBeDefined())
    server.notify('model/rerouted', {
      threadId: sessionId,
      turnId: turn!.id,
      fromModel: 'gpt-6',
      toModel: 'gpt-6-safe',
      reason: 'highRiskCyberActivity',
    })
    server.notify('modelProvider/authRecoveryStarted', {
      threadId: sessionId,
      turnId: turn!.id,
      provider: 'openai',
      message: 'Refreshing',
    })
    turn!.completed()
    await prompt
    expect(notices(events).map((n) => n.kind + ': ' + n.message)).toEqual([
      'warning: bubblewrap not found',
      'warning: The MCP server linear did not start',
      'warning: Old flag',
      'model_fallback: Codex moved this turn from gpt-6 to gpt-6-safe',
    ])
    const order = names(events)
    expect(order.indexOf('prompt_started')).toBeLessThan(order.indexOf('provider_notice'))
  })

  it('opens a background turn for one Codex starts itself, and a prompt waits for it', async () => {
    let turn: FakeCodexTurn | undefined
    const { server, runtime, events } = build({ onTurn: (t) => (turn = t) })
    const { sessionId } = await runtime.start()
    const thread = server.thread({ id: sessionId })
    const own = thread.turn()
    own.started()
    await vi.waitFor(() => expect(names(events)).toContain('background_turn_started'))
    expect(events.find((e) => e.event === 'turn_identified')).toMatchObject({
      data: { providerTurnId: own.id },
    })
    own.agentMessage('Continuing the goal.')

    const prompt = runtime.prompt({ prompt: PROMPT })
    await settle()
    expect(server.requests('turn/start')).toHaveLength(0)
    own.completed()
    await vi.waitFor(() => expect(turn).toBeDefined())
    turn!.completed()
    await prompt

    const order = names(events).filter((n) =>
      ['background_turn_started', 'prompt_started', 'prompt_completed'].includes(n),
    )
    expect(order).toEqual(['background_turn_started', 'prompt_completed', 'prompt_started', 'prompt_completed'])
    expect(texts(events)).toBe('Continuing the goal.')
  })

  it('reports a background turn’s tools, and settles a command it leaves running', async () => {
    const { server, runtime, events } = build()
    const { sessionId } = await runtime.start()
    const own = server.thread({ id: sessionId }).turn()
    own.started()
    await vi.waitFor(() => expect(names(events)).toContain('background_turn_started'))
    own.itemStarted({ ...codexBuilders.commandExecutionItem('npm run dev'), id: 'dev', processId: '77' })
    own.command('npm test', { output: 'ok\n' })
    own.completed()
    await vi.waitFor(() => expect(names(events)).toContain('prompt_completed'))
    const order = names(events)
    expect(order.indexOf('background_turn_started')).toBeLessThan(order.indexOf('tool_call'))
    const settled = events
      .filter((e) => e.event === 'tool_call_update')
      .map((e) => e.data as ToolCallUpdate)
    expect(settled).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ toolCallId: 'dev', status: 'completed' }),
        expect.objectContaining({ status: 'completed', rawInput: expect.objectContaining({ exitCode: 0 }) }),
      ]),
    )
    expect(order.lastIndexOf('tool_call_update')).toBeLessThan(order.indexOf('prompt_completed'))
  })

  it('leaves a running command to the server when the host stops the turn', async () => {
    let turn: FakeCodexTurn | undefined
    const { runtime, events } = build({ onTurn: (t) => (turn = t), interruptGraceMs: 30 })
    await runtime.start()
    const prompt = runtime.prompt({ prompt: PROMPT }).catch(() => undefined)
    await vi.waitFor(() => expect(turn).toBeDefined())
    turn!.started()
    turn!.itemStarted({ ...codexBuilders.commandExecutionItem('npm run dev'), id: 'dev', processId: '77' })
    await vi.waitFor(() => expect(names(events)).toContain('tool_call'))
    await runtime.cancel()
    await prompt
    expect(events.filter((e) => e.event === 'tool_call_update')).toEqual([])
  })

  it('counts a background turn as busy, so it is not reaped or evicted under it', async () => {
    const { server, runtime, events } = build()
    const { sessionId } = await runtime.start()
    expect(runtime.busy).toBe(false)
    const own = server.thread({ id: sessionId }).turn()
    own.started()
    await vi.waitFor(() => expect(names(events)).toContain('background_turn_started'))
    expect(runtime.busy).toBe(true)
    own.completed()
    await vi.waitFor(() => expect(names(events)).toContain('prompt_completed'))
    expect(runtime.busy).toBe(false)
  })

  it('starts no turn for a prompt stopped while it waited on a background turn', async () => {
    const { server, runtime, events } = build({ onTurn: (t) => t.completed() })
    server.respond('turn/interrupt', {}, { after: () => own.interrupted() })
    const { sessionId } = await runtime.start()
    const own = server.thread({ id: sessionId }).turn()
    own.started()
    await vi.waitFor(() => expect(names(events)).toContain('background_turn_started'))
    const prompt = runtime.prompt({ prompt: PROMPT })
    await settle()
    await runtime.cancel()
    await expect(prompt).resolves.toBeUndefined()
    expect(server.requests('turn/start')).toHaveLength(0)
    expect(names(events)).not.toContain('prompt_started')
    // And the next prompt runs.
    await runtime.prompt({ prompt: PROMPT })
    expect(server.requests('turn/start')).toHaveLength(1)
  })

  it('stops a background turn on cancel', async () => {
    const { server, runtime, events } = build()
    server.respond('turn/interrupt', {}, { after: () => own.interrupted() })
    const { sessionId } = await runtime.start()
    const own = server.thread({ id: sessionId }).turn()
    own.started()
    await vi.waitFor(() => expect(names(events)).toContain('background_turn_started'))
    await runtime.cancel()
    expect(events.find((e) => e.event === 'prompt_completed')).toMatchObject({
      data: { stopReason: 'cancelled' },
    })
  })

  it('counts neither a subagent’s tokens nor the thread’s history in a turn, and sizes the context from the last request', async () => {
    let turn: FakeCodexTurn | undefined
    const { runtime, events } = build({ onTurn: (t) => (turn = t) })
    await runtime.start()
    const prompt = runtime.prompt({ prompt: PROMPT })
    await vi.waitFor(() => expect(turn).toBeDefined())
    turn!.tokenUsage({ totalTokens: 100, inputTokens: 90, outputTokens: 10 }, { totalTokens: 1_100, inputTokens: 1_000, outputTokens: 100 })
    turn!.thread.child().turn().started().tokenUsage({ totalTokens: 5_000 }, { totalTokens: 50_000 })
    turn!.tokenUsage({ totalTokens: 300, inputTokens: 250, outputTokens: 50 }, { totalTokens: 1_400, inputTokens: 1_250, outputTokens: 150 })
    turn!.completed()
    await prompt
    expect(events.find((e) => e.event === 'prompt_completed')).toMatchObject({
      data: { usage: { totalTokens: 400, inputTokens: 340, outputTokens: 60 } },
    })
    const usage = events.filter((e) => e.event === 'usage_update').at(-1)
    expect((usage!.data as { used: number }).used).toBe(300)
  })
})

describe('CodexSessionRuntime restarts (CAL-254)', () => {
  it('interrupts a running turn before the process goes, fails it for a retry, and settles what waits', async () => {
    let turn: FakeCodexTurn | undefined
    const { server, runtime, events, exits } = build({ onTurn: (t) => (turn = t) })
    server.respond('turn/interrupt', {}, { after: () => setTimeout(() => turn!.interrupted(), 5) })
    const settleThread = vi.spyOn(InteractionBroker.prototype, 'settleThread')
    try {
      await runtime.start()
      const prompt = runtime.prompt({ prompt: PROMPT })
      await vi.waitFor(() => expect(turn).toBeDefined())
      await vi.waitFor(() => expect(names(events)).toContain('turn_identified'))
      await runtime.stop({ reason: 'disposed' })
      await expect(prompt).rejects.toThrow(/stopped Codex/)
      expect(server.requests('turn/interrupt')[0]!.params).toMatchObject({ turnId: turn!.id })
      // Not the user's Stop: it fails, and can be sent again.
      expect(names(events)).not.toContain('prompt_completed')
      expect(events.filter((e) => e.event === 'runtime_error')).toEqual([
        expect.objectContaining({
          data: expect.objectContaining({
            kind: 'process',
            problem: { code: 'unknown', action: 'retry', detail: expect.stringMatching(/restarted or updated/) },
          }),
        }),
      ])
      expect(events.find((e) => e.event === 'process_exited')).toMatchObject({ data: { expected: true } })
      expect(exits).toMatchObject([{ expected: true, reason: 'disposed' }])
      expect(settleThread).toHaveBeenCalledWith('codex', 'thread-1')
    } finally {
      settleThread.mockRestore()
    }
  })

  it('does not wait long on a turn that ignores the interrupt at shutdown', async () => {
    let turn: FakeCodexTurn | undefined
    const { server, runtime, exits, events } = build({ onTurn: (t) => (turn = t), interruptGraceMs: 30 })
    server.respond('turn/interrupt', {})
    await runtime.start()
    const prompt = runtime.prompt({ prompt: PROMPT })
    await vi.waitFor(() => expect(turn).toBeDefined())
    await runtime.stop({ reason: 'evicted' })
    await expect(prompt).rejects.toThrow(/stopped Codex/)
    expect(exits).toMatchObject([{ expected: true }])
    expect(events.find((e) => e.event === 'runtime_error')).toMatchObject({
      data: { problem: { action: 'retry' } },
    })
  })

  it('resumes the session on the next prompt after the process went away', async () => {
    const first = build({ onTurn: (t) => t.completed() })
    const { sessionId } = await first.runtime.start()
    await first.runtime.prompt({ prompt: PROMPT })
    await first.runtime.stop({ reason: 'disposed' })

    const server = new FakeCodexAppServer()
    server.respond('model/list', MODELS as never)
    serveStored(server, sessionId, (t) => t.completed())
    const second = build({ server, spec: { sessionId } })
    await second.runtime.prompt({ prompt: PROMPT })
    expect(server.requests('thread/resume')[0]!.params).toMatchObject({ threadId: sessionId })
    expect(server.requests('thread/start')).toHaveLength(0)
    expect(server.requests('turn/start')[0]!.params).toMatchObject({ threadId: sessionId })
    expect(names(second.events)).toEqual(
      expect.arrayContaining(['session_loaded', 'prompt_started', 'prompt_completed']),
    )
    expect(names(second.events)).not.toContain('session_created')
  })
})

describe('CodexSessionRuntime composer settings', () => {
  const { buildModel, buildRequirements } = codexBuilders
  const CATALOG = {
    data: [
      buildModel('gpt-6-luna', {
        isDefault: true,
        inputModalities: ['text', 'image'],
        supportedReasoningEfforts: [
          { reasoningEffort: 'low', description: 'Fast responses with lighter reasoning' },
          { reasoningEffort: 'high', description: 'Greater reasoning depth for complex problems' },
          { reasoningEffort: 'ultra', description: 'Maximum reasoning with automatic task delegation' },
        ],
      }),
      buildModel('gpt-6-mini', {
        inputModalities: ['text'],
        supportedReasoningEfforts: [
          { reasoningEffort: 'low', description: '' },
          { reasoningEffort: 'medium', description: '' },
        ],
        defaultReasoningEffort: 'medium',
      }),
    ],
    nextCursor: null,
  }

  function session(
    options: {
      spec?: Partial<SessionRuntimeSpec>
      onTurn?: (turn: FakeCodexTurn) => void
      setup?: (server: FakeCodexAppServer) => void
      controlRequestMs?: number
    } = {},
  ) {
    const server = new FakeCodexAppServer()
    server.respond('model/list', CATALOG as never).serveThreads(options.onTurn)
    options.setup?.(server)
    return build({
      server,
      ...(options.spec ? { spec: options.spec } : {}),
      ...(options.controlRequestMs ? { controlRequestMs: options.controlRequestMs } : {}),
    })
  }

  const option = (events: BackendEvent[], id: string) => {
    const last = [...events]
      .reverse()
      .find((e) => e.event === 'config_option_update' || e.event === 'session_created')
    const options = (last?.data as { configOptions?: Array<{ id: string; currentValue: unknown }> })
      .configOptions
    return options?.find((candidate) => candidate.id === id)?.currentValue
  }

  it('announces Access, effort, speed and web search with the session', async () => {
    const { runtime, events } = session()
    await runtime.start()
    const created = events.find((e) => e.event === 'session_created')!
    expect(created.data).toMatchObject({
      modes: {
        currentModeId: 'auto-accept-edits',
        availableModes: [
          { id: 'supervised', displayName: 'Supervised' },
          { id: 'auto-accept-edits', displayName: 'Auto-accept edits' },
          { id: 'auto', displayName: 'Auto' },
          { id: 'full-access', displayName: 'Full access' },
        ],
      },
      configOptions: [
        {
          id: 'effort',
          currentValue: 'low',
          options: [
            { value: 'low', name: 'Low' },
            { value: 'high', name: 'High' },
            { value: 'ultra', name: 'Ultra', description: expect.stringMatching(/May start subagents on its own/) },
          ],
        },
        { id: 'service_tier', currentValue: 'default' },
        { id: 'web_search', currentValue: 'cached' },
      ],
    })
  })

  it('sends a change between turns through thread/settings/update and shows what Codex reads back', async () => {
    let turn: FakeCodexTurn | undefined
    const { server, runtime, events } = session({ onTurn: (t) => (turn = t) })
    await runtime.start()

    await runtime.setConfigOption('effort', 'high')
    await runtime.setConfigOption('service_tier', 'priority')
    expect(server.requests('thread/settings/update').map((r) => r.params)).toEqual([
      { threadId: runtime.sessionId, effort: 'high' },
      { threadId: runtime.sessionId, serviceTier: 'priority' },
    ])
    expect(option(events, 'effort')).toBe('high')
    expect(option(events, 'service_tier')).toBe('priority')

    // A value Codex already has is not sent again: it would read nothing back.
    await runtime.setConfigOption('effort', 'high')
    expect(server.requests('thread/settings/update')).toHaveLength(2)

    await runtime.setMode('supervised')
    expect(server.requests('thread/settings/update')[2]!.params).toEqual({
      threadId: runtime.sessionId,
      approvalPolicy: 'untrusted',
      approvalsReviewer: 'user',
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
    })
    expect(events.filter((e) => e.event === 'current_mode_update').at(-1)).toMatchObject({
      data: { currentModeId: 'supervised' },
    })

    // Every turn still sends every setting.
    const prompt = runtime.prompt({ prompt: PROMPT })
    await vi.waitFor(() => expect(turn).toBeDefined())
    expect(server.requests('turn/start')[0]!.params).toMatchObject({
      model: 'gpt-6-luna',
      effort: 'high',
      serviceTier: 'priority',
      approvalPolicy: 'untrusted',
      sandboxPolicy: { type: 'readOnly' },
    })
    turn!.completed()
    await prompt
  })

  it('refuses a change Codex reads back otherwise, and shows what it kept', async () => {
    const { server, runtime, events } = session({ controlRequestMs: 200 })
    await runtime.start()
    server.respond('thread/settings/update', (params) => {
      setImmediate(() =>
        server.notify('thread/settings/updated', {
          threadId: params.threadId,
          threadSettings: codexBuilders.buildThreadSettings({ model: 'gpt-6-luna', effort: 'low', serviceTier: 'default' }),
        }),
      )
      return {}
    })
    await expect(runtime.setConfigOption('effort', 'high')).rejects.toThrow(/kept its own effort: low/)
    expect(option(events, 'effort')).toBe('low')
  })

  it('refuses values the model does not offer, and presets a policy rules out', async () => {
    const { runtime } = session({
      setup: (server) =>
        server.respond('configRequirements/read', {
          supportsIndependentSpeedModes: true,
          requirements: buildRequirements({ allowedSandboxModes: ['read-only', 'workspace-write'] }),
        } as never),
    })
    await runtime.start()
    await expect(runtime.setConfigOption('effort', 'medium')).rejects.toThrow(/does not offer medium/)
    await expect(runtime.setConfigOption('bogus', 'x')).rejects.toThrow(/no setting bogus/)
    await expect(runtime.setMode('plan')).rejects.toThrow(/no access preset plan/)
    await expect(runtime.setMode('full-access')).rejects.toThrow(/administrator/)
  })

  it('queues a change made during a turn for the next turn/start', async () => {
    const turns: FakeCodexTurn[] = []
    const { server, runtime, events } = session({ onTurn: (t) => turns.push(t) })
    await runtime.start()
    const first = runtime.prompt({ prompt: PROMPT })
    await vi.waitFor(() => expect(turns).toHaveLength(1))

    await runtime.setMode('full-access')
    await runtime.setConfigOption('effort', 'ultra')
    expect(server.requests('thread/settings/update')).toHaveLength(0)
    // Shown as what the next turn runs with.
    expect(events.filter((e) => e.event === 'current_mode_update').at(-1)).toMatchObject({
      data: { currentModeId: 'full-access' },
    })
    expect(option(events, 'effort')).toBe('ultra')

    turns[0]!.completed()
    await first
    const second = runtime.prompt({ prompt: PROMPT })
    await vi.waitFor(() => expect(turns).toHaveLength(2))
    expect(server.requests('turn/start')[1]!.params).toMatchObject({
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'dangerFullAccess' },
      effort: 'ultra',
    })
    turns[1]!.completed()
    await second
  })

  it('moves effort to what a new model offers when the model changes', async () => {
    const { server, runtime, events } = session()
    await runtime.start()
    await runtime.setConfigOption('effort', 'ultra')
    await runtime.setModel('gpt-6-mini')
    expect(server.requests('thread/settings/update').at(-1)!.params).toEqual({
      threadId: runtime.sessionId,
      model: 'gpt-6-mini',
      effort: 'medium',
    })
    expect(events.filter((e) => e.event === 'current_model_update').at(-1)).toMatchObject({
      data: { currentModelId: 'gpt-6-mini' },
    })
    expect(option(events, 'effort')).toBe('medium')
  })

  it('opens the thread again with a new web search mode, which sticks to the thread', async () => {
    let turn: FakeCodexTurn | undefined
    const { server, runtime } = session({ onTurn: (t) => (turn = t) })
    await runtime.start()
    const threadId = runtime.sessionId
    const prompt = runtime.prompt({ prompt: PROMPT })
    await vi.waitFor(() => expect(turn).toBeDefined())
    turn!.completed()
    await prompt

    await runtime.setConfigOption('web_search', 'live')
    expect(server.requests('thread/unsubscribe')[0]!.params).toEqual({ threadId })
    expect(server.requests('thread/resume')[0]!.params).toMatchObject({
      threadId,
      config: { notify: [], web_search: 'live' },
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
    })
    expect(runtime.sessionId).toBe(threadId)
  })

  it('starts a thread that never ran a turn again for a new web search mode', async () => {
    const { server, runtime, events } = session()
    await runtime.start()
    const first = runtime.sessionId
    await runtime.setConfigOption('web_search', 'disabled')
    // Nothing on disk to resume: a fresh thread, announced so the host stamps it.
    expect(server.requests('thread/start')).toHaveLength(2)
    expect(server.requests('thread/start')[1]!.params).toMatchObject({
      config: { notify: [], web_search: 'disabled' },
    })
    expect(runtime.sessionId).not.toBe(first)
    expect(events.filter((e) => e.event === 'session_created').at(-1)!.sessionId).toBe(runtime.sessionId)
  })

  it('restores the session’s access preset and settings when its process starts', async () => {
    let turn: FakeCodexTurn | undefined
    const { server, runtime, events } = session({
      onTurn: (t) => (turn = t),
      spec: {
        desiredConfig: {
          modeId: 'supervised',
          values: { effort: 'high', service_tier: 'priority', web_search: 'disabled' },
        },
      },
    })
    await runtime.start()
    expect(server.requests('thread/start')[0]!.params).toMatchObject({
      approvalPolicy: 'untrusted',
      sandbox: 'read-only',
      config: { notify: [], web_search: 'disabled' },
    })
    expect(events.find((e) => e.event === 'session_created')!.data).toMatchObject({
      modes: { currentModeId: 'supervised' },
    })
    const prompt = runtime.prompt({ prompt: PROMPT })
    await vi.waitFor(() => expect(turn).toBeDefined())
    expect(server.requests('turn/start')[0]!.params).toMatchObject({
      effort: 'high',
      serviceTier: 'priority',
      approvalPolicy: 'untrusted',
    })
    turn!.completed()
    await prompt
  })

  it('refuses an image for a model that cannot read one, before the turn', async () => {
    const { server, runtime } = session()
    await runtime.start()
    await runtime.setModel('gpt-6-mini')
    await expect(
      runtime.prompt({
        prompt: {
          text: 'look',
          blocks: [
            { type: 'text', text: 'look' },
            { type: 'image', mimeType: 'image/png', data: 'AAAA' },
          ],
        },
      }),
    ).rejects.toThrow(/GPT-6-MINI cannot read images/)
    expect(server.requests('turn/start')).toHaveLength(0)
  })

  /** A session whose thread has run one turn, so Codex has it on disk. */
  async function prompted(options: Parameters<typeof session>[0] = {}) {
    const turns: FakeCodexTurn[] = []
    const built = session({ ...options, onTurn: (t) => turns.push(t) })
    await built.runtime.start()
    const first = built.runtime.prompt({ prompt: PROMPT })
    await vi.waitFor(() => expect(turns).toHaveLength(1))
    turns[0]!.completed()
    await first
    /** Run one more turn, with what the host would pass. */
    const turn = async (desiredConfig?: DesiredSessionConfig) => {
      const count = turns.length
      const next = built.runtime.prompt({ prompt: PROMPT, ...(desiredConfig ? { desiredConfig } : {}) })
      await vi.waitFor(() => expect(turns).toHaveLength(count + 1))
      turns[count]!.completed()
      await next
      return built.server.requests('turn/start').at(-1)!.params
    }
    return { ...built, turns, turn }
  }

  // Review: a draft's Supervised was shown while turns ran on the default.
  it('applies the access preset a prompt names, as a draft’s first turn does', async () => {
    let turn: FakeCodexTurn | undefined
    const { server, runtime, events } = session({ onTurn: (t) => (turn = t) })
    await runtime.start()
    const prompt = runtime.prompt({ prompt: PROMPT, desiredConfig: { modeId: 'supervised' } })
    await vi.waitFor(() => expect(turn).toBeDefined())
    expect(server.requests('turn/start')[0]!.params).toMatchObject({
      approvalPolicy: 'untrusted',
      sandboxPolicy: { type: 'readOnly' },
    })
    expect(events.filter((e) => e.event === 'current_mode_update').at(-1)).toMatchObject({
      data: { currentModeId: 'supervised' },
    })
    turn!.completed()
    await prompt
  })

  it('does not take a preset a policy rules out from a prompt', async () => {
    const { turn } = await prompted({
      setup: (server) =>
        server.respond('configRequirements/read', {
          supportsIndependentSpeedModes: true,
          requirements: buildRequirements({ allowedSandboxModes: ['read-only', 'workspace-write'] }),
        } as never),
    })
    expect(await turn({ modeId: 'full-access' })).toMatchObject({ approvalPolicy: 'on-request' })
  })

  // Review: a refused setMode('full-access') still ran the next turn unsandboxed.
  it('leaves the selection as it was when Codex refuses a change', async () => {
    const { server, runtime, events, turn } = await prompted()
    server.fail('thread/settings/update', -32600, 'not now')
    await expect(runtime.setMode('full-access')).rejects.toThrow(/not now/)
    await expect(runtime.setConfigOption('effort', 'ultra')).rejects.toThrow(/not now/)
    // Never shown as taken.
    expect(
      events.filter((e) => e.event === 'current_mode_update').map((e) => (e.data as { currentModeId: string }).currentModeId),
    ).not.toContain('full-access')
    expect(option(events, 'effort')).toBe('low')
    expect(await turn()).toMatchObject({
      approvalPolicy: 'on-request',
      sandboxPolicy: { type: 'workspaceWrite' },
      effort: 'low',
    })
  })

  it('sends a change at the next turn when this Codex has no thread/settings/update', async () => {
    const { server, runtime, turn } = await prompted()
    server.fail('thread/settings/update', -32601, 'unknown method')
    await runtime.setConfigOption('effort', 'high')
    await runtime.setMode('supervised')
    expect(await turn()).toMatchObject({ effort: 'high', approvalPolicy: 'untrusted' })
  })

  it('queues a change for the next turn while the thread is to be opened again', async () => {
    const { server, runtime, turn } = await prompted()
    server.notify('thread/closed', { threadId: runtime.sessionId! })
    await vi.waitFor(() =>
      expect((runtime as unknown as { reopen: unknown }).reopen).toBe('closed'),
    )
    const updates = server.requests('thread/settings/update').length
    await runtime.setMode('supervised')
    expect(server.requests('thread/settings/update')).toHaveLength(updates)
    expect(await turn()).toMatchObject({ approvalPolicy: 'untrusted', sandboxPolicy: { type: 'readOnly' } })
    expect(server.requests('thread/resume').at(-1)!.params).toMatchObject({ sandbox: 'read-only' })
  })

  // Review: High → Low → High lost the last one; each waits for its own read-back.
  it('runs quick changes one at a time, each on its own read-back', async () => {
    const { server, runtime, events, turn } = await prompted()
    await Promise.all([
      runtime.setConfigOption('effort', 'high'),
      runtime.setConfigOption('effort', 'low'),
      runtime.setConfigOption('effort', 'high'),
      runtime.setConfigOption('effort', 'ultra'),
    ])
    expect(server.requests('thread/settings/update').map((r) => r.params.effort)).toEqual([
      'high',
      'low',
      'high',
      'ultra',
    ])
    expect(option(events, 'effort')).toBe('ultra')
    expect(await turn()).toMatchObject({ effort: 'ultra' })
  })

  it('waits past an earlier change’s read-back for its own', async () => {
    const { server, runtime } = await prompted({ controlRequestMs: 500 })
    // Codex reads back a stale value first, then the change.
    server.respond('thread/settings/update', (params) => {
      const settings = (effort: string) =>
        codexBuilders.buildThreadSettings({ model: 'gpt-6-luna', effort, serviceTier: 'default' })
      setImmediate(() => {
        server.notify('thread/settings/updated', { threadId: params.threadId, threadSettings: settings('low') })
        setImmediate(() =>
          server.notify('thread/settings/updated', {
            threadId: params.threadId,
            threadSettings: settings(params.effort!),
          }),
        )
      })
      return {}
    })
    await expect(runtime.setConfigOption('effort', 'high')).resolves.toBeUndefined()
  })

  // Review: a reopen raced a prompt, orphaning a thread.
  it('opens the thread once for a web search change, with a prompt right behind it', async () => {
    const { server, runtime, turns } = await prompted()
    const threadId = runtime.sessionId
    const change = runtime.setConfigOption('web_search', 'live')
    const next = runtime.prompt({
      prompt: PROMPT,
      // What the host knew before the change: it must not undo it.
      desiredConfig: { values: { web_search: 'cached' } },
    })
    await change
    await vi.waitFor(() => expect(turns).toHaveLength(2))
    turns[1]!.completed()
    await next
    expect(server.requests('thread/unsubscribe')).toHaveLength(1)
    expect(server.requests('thread/resume')).toHaveLength(1)
    expect(server.requests('thread/resume')[0]!.params).toMatchObject({
      config: { web_search: 'live' },
    })
    expect(runtime.sessionId).toBe(threadId)
    expect(server.requests('turn/start').at(-1)!.params.threadId).toBe(threadId)
  })

  // Review: a config reopen dropped the handover of a thread that had turns.
  it('keeps the handover when a thread with turns is gone at a web search reopen', async () => {
    const { server, runtime } = await prompted()
    server.fail('thread/resume', -32600, 'no rollout found for thread id gone')
    await runtime.setConfigOption('web_search', 'disabled')
    expect((runtime as unknown as { handover: unknown }).handover).toMatchObject({ from: expect.any(String) })
  })

  // Review: standard speed was always named, which older CLIs never saw.
  it('names a service tier on turn/start only when one other than standard is in play', async () => {
    const { server, runtime, turn } = await prompted()
    expect(server.requests('turn/start')[0]!.params).not.toHaveProperty('serviceTier')
    await runtime.setConfigOption('service_tier', 'priority')
    expect(await turn()).toMatchObject({ serviceTier: 'priority' })
    await runtime.setConfigOption('service_tier', 'default')
    expect(server.requests('thread/settings/update').at(-1)!.params).toMatchObject({ serviceTier: null })
    expect(await turn()).not.toHaveProperty('serviceTier')
  })

  it('refuses a preset a permission profile rules out, and starts a blocked restored one in another', async () => {
    const profiles = (server: FakeCodexAppServer) =>
      server.respond('permissionProfile/list', {
        data: codexBuilders.buildPermissionProfiles({ ':danger-full-access': false }),
        nextCursor: null,
      } as never)
    const { runtime } = session({ setup: profiles })
    await runtime.start()
    await expect(runtime.setMode('full-access')).rejects.toThrow(/administrator/)

    const restored = session({ setup: profiles, spec: { desiredConfig: { modeId: 'full-access' } } })
    await restored.runtime.start()
    expect(restored.server.requests('thread/start')[0]!.params).toMatchObject({
      sandbox: 'workspace-write',
      approvalPolicy: 'on-request',
    })
  })
})
