import { describe, expect, it, vi } from 'vitest'
import type { BackendEvent } from '../../backends/Backend.js'
import { SessionUnknownError } from '../../core/errors.js'
import { InteractionBroker } from '../../core/InteractionBroker.js'
import { PermissionBroker } from '../../core/PermissionBroker.js'
import { codex } from '../../providers/codex.js'
import type { SessionRuntimeSpec } from '../SessionRuntime.js'
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
      host: { log, onSessionTitle },
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

  it('steers the recorded turn and places the message where Codex echoed it', async () => {
    const server = new ReplayCodexAppServer('steer')
    server.respond('model/list', MODELS as never)
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

  // Review: a turn closed before Codex named it was never blocked: its late
  // `turn/completed` was claimed by the next prompt.
  it('blocks and interrupts a turn Codex names only after its start timed out', async () => {
    const turns: FakeCodexTurn[] = []
    const { server, runtime, events } = build({ onTurn: (t) => turns.push(t), controlRequestMs: 50 })
    server.respond('turn/interrupt', {} as never)
    await runtime.start()
    // The first `turn/start` answers too late for its budget.
    const thread = server.thread({ id: runtime.sessionId! } as never)
    const orphan = thread.turn()
    server.respond('turn/start', () => new Promise(() => undefined) as never, { times: 1 })
    const first = runtime.prompt({ prompt: PROMPT })
    await expect(first).rejects.toThrow(/did not answer/)
    // Codex started it all the same, and says so now.
    orphan.started()
    await vi.waitFor(() =>
      expect(server.requests('turn/interrupt').map((r) => r.params.turnId)).toContain(orphan.id),
    )
    let secondDone = false
    const second = runtime.prompt({ prompt: PROMPT }).then(() => (secondDone = true))
    await vi.waitFor(() => expect(turns).toHaveLength(1))
    orphan.completed() // the orphan's end must not end the second prompt
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(secondDone).toBe(false)
    turns[0]!.agentMessage('second answer')
    turns[0]!.completed()
    await second
    expect(texts(events)).toContain('second answer')
    const identified = events.filter((e) => e.event === 'turn_identified')
    expect(identified.map((e) => (e.data as { providerTurnId: string }).providerTurnId)).toEqual([
      turns[0]!.id,
    ])
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
