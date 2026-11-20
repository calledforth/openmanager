import type { SubtaskUpdate } from '@agentpack/contract'
import type { v2 } from '@openmanager/codex-app-server-protocol'
import { describe, expect, it, vi } from 'vitest'
import type { BackendEvent } from '../../backends/Backend.js'
import { SessionUnknownError } from '../../core/errors.js'
import { InteractionBroker } from '../../core/InteractionBroker.js'
import { PermissionBroker } from '../../core/PermissionBroker.js'
import { codex } from '../../providers/codex.js'
import type { SessionRuntimeSpec } from '../SessionRuntime.js'
import { CodexAppServerClient } from './CodexAppServerClient.js'
import { CodexSessionRuntime } from './CodexSessionRuntime.js'
import {
  codexNotificationScope,
  CodexSubagents,
  isCodexSubagentThread,
  type CodexSubagentOutput,
} from './codex-subagents.js'
import type { CodexStarter } from './start.js'
import { FakeCodexAppServer, type FakeCodexThread, type FakeCodexTurn } from './testing/index.js'
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
      inputModalities: ['text'],
    },
  ],
  nextCursor: null,
}

const PROMPT = { text: 'hi', blocks: [{ type: 'text' as const, text: 'hi' }] }

/** A runtime on a fake app-server; `onTurn` gets each parent turn. */
function build(
  options: {
    spec?: Partial<SessionRuntimeSpec>
    onTurn?: (turn: FakeCodexTurn) => void
    server?: FakeCodexAppServer
    subagentStopMs?: number
  } = {},
) {
  const server = options.server ?? new FakeCodexAppServer()
  if (!options.server) server.respond('model/list', MODELS as never).serveThreads(options.onTurn)
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
      timeouts: { interruptGraceMs: 200 },
      ...(options.subagentStopMs !== undefined ? { subagentStopMs: options.subagentStopMs } : {}),
    },
  )
  runtime.events((event) => events.push(event))
  return { server, runtime, events, log }
}

/** A runtime with a parent turn in flight. */
async function running(options: Parameters<typeof build>[0] = {}) {
  let turn: FakeCodexTurn | undefined
  const built = build({ ...options, onTurn: (t) => (turn = t) })
  await built.runtime.start()
  const prompt = built.runtime.prompt({ prompt: PROMPT })
  prompt.catch(() => undefined)
  await vi.waitFor(() => expect(turn).toBeDefined())
  return { ...built, turn: turn!, prompt }
}

/** Interrupting a turn on the fake ends it, as Codex does, a moment later. */
function interruptible(server: FakeCodexAppServer, turns: () => FakeCodexTurn[]) {
  server.respond('turn/interrupt', (params) => {
    const turn = turns().find((t) => t.id === params.turnId && t.threadId === params.threadId)
    if (turn) setTimeout(() => turn.interrupted(), 2)
    return {} as never
  })
}

const subtasks = (events: BackendEvent[]) =>
  events.filter((e) => e.event === 'subtask_update').map((e) => e.data as SubtaskUpdate)
const texts = (events: BackendEvent[]) =>
  events
    .filter((e) => e.event === 'agent_message_chunk')
    .map((e) => (e.data as { content: { text: string } }).content.text)
    .join('')
const tick = () => new Promise((resolve) => setTimeout(resolve, 10))

function collabCall(
  tool: v2.CollabAgentTool,
  sender: string,
  receivers: string[],
  overrides: Partial<Extract<v2.ThreadItem, { type: 'collabAgentToolCall' }>> = {},
): Extract<v2.ThreadItem, { type: 'collabAgentToolCall' }> {
  return {
    type: 'collabAgentToolCall',
    id: `call_${tool}_${Math.random().toString(36).slice(2, 8)}`,
    tool,
    status: 'inProgress',
    senderThreadId: sender,
    receiverThreadIds: receivers,
    prompt: null,
    model: null,
    reasoningEffort: null,
    agentsStates: {},
    ...overrides,
  }
}

describe('codexNotificationScope', () => {
  it('sends a notification to the thread it names, even a global method', () => {
    expect(codexNotificationScope('item/started', { threadId: 'c' })).toEqual({
      kind: 'thread',
      threadId: 'c',
    })
    expect(codexNotificationScope('mcpServer/startupStatus/updated', { threadId: 'c' })).toEqual({
      kind: 'thread',
      threadId: 'c',
    })
    expect(codexNotificationScope('thread/started', { thread: { id: 't' } })).toEqual({
      kind: 'thread',
      threadId: 't',
    })
  })

  it('keeps account, skills, MCP and Windows notifications global', () => {
    for (const method of [
      'account/updated',
      'account/rateLimits/updated',
      'skills/changed',
      'mcpServer/startupStatus/updated',
      'windowsSandbox/setupCompleted',
      'configWarning',
    ])
      expect(codexNotificationScope(method, { threadId: null })).toEqual({ kind: 'global' })
  })

  it('lets a thread-scoped notification that names no thread fall through to nobody', () => {
    expect(codexNotificationScope('turn/completed', { turn: {} })).toEqual({ kind: 'unscoped' })
    expect(codexNotificationScope('some/new/method', {})).toEqual({ kind: 'unscoped' })
  })

  it('knows a subagent’s thread', () => {
    expect(isCodexSubagentThread({ parentThreadId: 'p', source: 'appServer' })).toBe(true)
    expect(isCodexSubagentThread({ parentThreadId: null, source: { subAgent: 'review' } })).toBe(
      true,
    )
    expect(isCodexSubagentThread({ parentThreadId: null, source: 'appServer' })).toBe(false)
  })
})

describe('CodexSessionRuntime subagents', () => {
  it('shows a child as a card and keeps its stream out of the parent’s turn', async () => {
    const { runtime, events, turn, prompt } = await running()
    const child = turn.thread.child()
    const spawn = turn.spawnSubagent(child)
    const childTurn = child.turn().started()
    expect(runtime.busy).toBe(true)
    childTurn.reasoning(['**Child thinking**'])
    childTurn.command('ls', { output: 'a\n' })
    childTurn.agentMessage('42', { phase: 'final_answer' })
    childTurn.tokenUsage({ totalTokens: 900, inputTokens: 800, outputTokens: 100 })
    child.server.notify('error', {
      threadId: child.id,
      turnId: childTurn.id,
      willRetry: false,
      error: {
        message: 'child trouble',
        codexErrorInfo: null,
        additionalDetails: null,
        misalignment: null,
      },
    })
    turn.subagentCompleted(child)
    childTurn.completed()
    turn.agentMessage('The answer is 42', { phase: 'final_answer' })
    turn.tokenUsage({ totalTokens: 50, inputTokens: 40, outputTokens: 10 })
    turn.completed()
    await prompt

    // The parent's turn: its own text and usage, once, and no error.
    expect(texts(events)).toBe('The answer is 42')
    expect(events.filter((e) => e.event === 'agent_thought_chunk')).toEqual([])
    expect(events.filter((e) => e.event === 'runtime_error')).toEqual([])
    expect(events.filter((e) => e.event === 'prompt_completed')).toMatchObject([
      { data: { stopReason: 'end_turn', usage: { totalTokens: 50 } } },
    ])
    // The card: started from the parent's item, settled with the answer.
    const updates = subtasks(events)
    expect(updates[0]).toMatchObject({
      taskId: child.id,
      toolCallId: spawn.id,
      title: 'helper',
      status: 'running',
      depth: 1,
      stoppable: true,
      promptable: false,
    })
    expect(updates.at(-1)).toMatchObject({
      taskId: child.id,
      status: 'completed',
      statusSource: 'turn_result',
      resultText: '42',
      tokens: 900,
      toolCallCount: 1,
    })
    expect(updates.every((u) => u.taskId === child.id)).toBe(true)
    // Child events are never this session's.
    expect(
      events.every((e) => e.sessionId === undefined || e.sessionId === runtime.sessionId),
    ).toBe(true)
    expect(runtime.busy).toBe(false)
  })

  it('buffers a child’s turn that starts before the child is known', async () => {
    const { server, runtime, events, turn, prompt } = await running()
    const child = turn.thread.child()
    const childTurn = child.turn().started()
    await tick()
    expect(runtime.busy).toBe(false)
    turn.spawnSubagent(child)
    await vi.waitFor(() => expect(runtime.busy).toBe(true))
    interruptible(server, () => [turn, childTurn])
    await runtime.cancel()
    await prompt
    await vi.waitFor(() => expect(runtime.busy).toBe(false))
    expect(server.requests('turn/interrupt').map((r) => r.params)).toEqual([
      { threadId: turn.threadId, turnId: turn.id },
      { threadId: child.id, turnId: childTurn.id },
    ])
    expect(subtasks(events).at(-1)).toMatchObject({ taskId: child.id, status: 'interrupted' })
  })

  it('stops the parent turn and every child, including one that starts late', async () => {
    const { server, runtime, turn, prompt } = await running()
    const first = turn.thread.child({ agentNickname: 'first' })
    const second = turn.thread.child({ agentNickname: 'second' })
    const turns: FakeCodexTurn[] = [turn]
    interruptible(server, () => turns)
    turn.spawnSubagent(first)
    turns.push(first.turn().started())
    // A grandchild, started by the first child.
    const grandchild = first.child()
    turns[1]!.spawnSubagent(grandchild)
    turns.push(grandchild.turn().started())
    await vi.waitFor(() => expect(runtime.busy).toBe(true))

    // The second child was spawned just before the stop and only shows
    // itself after it, before the parent's turn ends; its turn starts later
    // still.
    server.respond('turn/interrupt', (params) => {
      const target = turns.find((t) => t.id === params.turnId && t.threadId === params.threadId)
      if (target && target !== turn) setTimeout(() => target.interrupted(), 2)
      if (target === turn)
        setTimeout(() => {
          turn.spawnSubagent(second)
          setTimeout(() => turn.interrupted(), 5)
          setTimeout(() => turns.push(second.turn().started()), 15)
        }, 5)
      return {} as never
    })
    await runtime.cancel()
    await prompt
    await vi.waitFor(() => expect(runtime.busy).toBe(false))
    const interrupted = server.requests('turn/interrupt').map((r) => r.params.threadId)
    expect(interrupted).toEqual(
      expect.arrayContaining([turn.threadId, first.id, grandchild.id, second.id]),
    )
    expect(interrupted).toHaveLength(4)
    expect(runtime.busy).toBe(false)
  })

  it('gives up on a child that will not stop, within the bound', async () => {
    const { server, runtime, turn, prompt, log } = await running({ subagentStopMs: 40 })
    const child = turn.thread.child()
    turn.spawnSubagent(child)
    const childTurn = child.turn().started()
    interruptible(server, () => [turn])
    const started = Date.now()
    await runtime.cancel()
    await prompt
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(server.requests('turn/interrupt').map((r) => r.params.threadId)).toContain(child.id)
    await vi.waitFor(() =>
      expect(log).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringMatching(/still running/) }),
      ),
    )
    expect(runtime.busy).toBe(true)
    childTurn.interrupted()
    await vi.waitFor(() => expect(runtime.busy).toBe(false))
  })

  it('stops children running in the background when there is no parent turn', async () => {
    const { server, runtime, events, turn, prompt } = await running()
    const child = turn.thread.child()
    turn.spawnSubagent(child)
    const childTurn = child.turn().started()
    turn.completed()
    await prompt
    // The parent's turn ended; its child runs on in the background.
    expect(subtasks(events)).toContainEqual({ taskId: child.id, background: true })
    expect(runtime.busy).toBe(true)
    // Its late stream still never reaches the parent.
    childTurn.agentMessage('late')
    await tick()
    expect(texts(events)).toBe('')

    interruptible(server, () => [childTurn])
    await runtime.cancel()
    await vi.waitFor(() => expect(runtime.busy).toBe(false))
    expect(server.requests('turn/interrupt').map((r) => r.params.threadId)).toEqual([child.id])
  })

  it('stops one child from its card', async () => {
    const { server, runtime, turn } = await running()
    const one = turn.thread.child()
    const other = turn.thread.child()
    turn.spawnSubagent(one)
    turn.spawnSubagent(other)
    const oneTurn = one.turn().started()
    const otherTurn = other.turn().started()
    interruptible(server, () => [oneTurn, otherTurn])
    await vi.waitFor(() => expect(runtime.busy).toBe(true))
    await runtime.stopSubtask(one.id)
    expect(server.requests('turn/interrupt').map((r) => r.params.threadId)).toEqual([one.id])
    expect(runtime.busy).toBe(true)
    runtime.dispose()
  })

  it('shows the parent’s other collab calls as tool rows and tracks what they do', async () => {
    const { runtime, events, turn, prompt } = await running()
    const child = turn.thread.child()
    const parent = turn.threadId

    // Older Codex: the spawn is a collab call, and carries the prompt.
    const spawn = collabCall('spawnAgent', parent, [], {
      prompt: 'Count the files',
      model: 'gpt-6-luna',
    })
    turn.itemStarted(spawn)
    turn.itemCompleted({ ...spawn, status: 'completed', receiverThreadIds: [child.id] })
    const childTurn = child.turn().started()

    const wait = collabCall('wait', parent, [child.id])
    turn.itemStarted(wait)
    childTurn.agentMessage('3 files', { phase: 'final_answer' })
    childTurn.completed()
    turn.itemCompleted({
      ...wait,
      status: 'completed',
      agentsStates: { [child.id]: { status: 'completed', message: '3 files' } },
    })

    const send = collabCall('sendInput', parent, [child.id], { prompt: 'And dirs?' })
    turn.itemStarted(send)
    turn.itemCompleted({ ...send, status: 'completed' })
    const second = child.turn().started()
    second.completed()

    const close = collabCall('closeAgent', parent, [child.id])
    turn.itemStarted(close)
    turn.itemCompleted({
      ...close,
      status: 'completed',
      agentsStates: { [child.id]: { status: 'shutdown', message: null } },
    })
    for (const tool of [
      'resumeAgent',
      'interruptAgent',
      'listAgents',
      'followupTask',
      'sendMessage',
    ] as const) {
      const call = collabCall(tool, parent, tool === 'listAgents' ? [] : [child.id])
      turn.itemStarted(call)
      turn.itemCompleted({ ...call, status: 'completed' })
    }
    turn.completed()
    await prompt

    const updates = subtasks(events)
    expect(updates[0]).toMatchObject({
      taskId: child.id,
      toolCallId: spawn.id,
      prompt: 'Count the files',
      modelId: 'gpt-6-luna',
      status: 'running',
    })
    // Settled, revived by the message, settled again.
    expect(updates.map((u) => u.status).filter(Boolean)).toEqual([
      'running',
      'completed',
      'running',
      'completed',
    ])
    const rows = events.filter((e) => e.event === 'tool_call')
    expect(rows.map((e) => (e.data as { title: string }).title)).toEqual([
      'Waiting for a subagent',
      'Messaging a subagent',
      'Closing a subagent',
      'Resuming a subagent',
      'Interrupting a subagent',
      'Listing subagents',
      'Messaging a subagent',
      'Messaging a subagent',
    ])
    expect(events.find((e) => e.event === 'tool_call_update')).toMatchObject({
      data: { toolCallId: wait.id, status: 'completed', toolName: 'wait', kind: 'other' },
    })
    // No row for the spawn: the card takes its place.
    expect(rows.some((e) => (e.data as { toolCallId: string }).toolCallId === spawn.id)).toBe(false)
    expect(runtime.busy).toBe(false)
  })

  it('handles every subagent activity kind', async () => {
    const { events, turn, prompt, server } = await running()
    const child = turn.thread.child()
    const restarted = turn.thread.child({ agentNickname: 'old' })
    turn.spawnSubagent(child)
    const activity = (target: FakeCodexThread, kind: v2.SubAgentActivityKind) => {
      const item = {
        type: 'subAgentActivity' as const,
        model: null,
        reasoningEffort: null,
        id: `activity-${kind}-${target.id}`,
        kind,
        agentThreadId: target.id,
        agentPath: '/root/old',
      }
      turn.itemStarted(item)
      turn.itemCompleted(item)
    }
    activity(child, 'interrupted')
    activity(child, 'interacted')
    activity(child, 'completed')
    // A child from before a restart, reached again: known from then on.
    activity(restarted, 'interacted')
    const lateTurn = restarted.turn().started()
    lateTurn.agentMessage('still here')
    lateTurn.completed()
    turn.completed()
    await prompt
    expect(texts(events)).toBe('')
    const byChild = (id: string) => subtasks(events).filter((u) => u.taskId === id && u.status)
    expect(byChild(child.id).map((u) => u.status)).toEqual(['running', 'interrupted', 'completed'])
    // Known but cardless until it runs: Codex had not said it exists.
    expect(byChild(restarted.id).map((u) => u.status)).toEqual(['running', 'completed'])
    expect(byChild(restarted.id)[0]).toMatchObject({ title: 'old' })
    void server
  })

  it('drops a thread-scoped notification that names no thread', async () => {
    const { server, events, turn, prompt } = await running()
    // A `turn/completed` without a thread id would otherwise end the turn.
    server.notify('turn/completed', { turn: { ...turn.turn, status: 'completed' } } as never)
    await tick()
    expect(events.some((e) => e.event === 'prompt_completed')).toBe(false)
    turn.completed()
    await prompt
  })

  it('never resumes a subagent’s thread as a session', async () => {
    const server = new FakeCodexAppServer()
    server.respond('model/list', MODELS as never).serveThreads()
    const parent = server.thread({ id: 'parent' })
    const child = parent.child({ id: 'child' })
    server.respond('thread/resume', child.startResponse() as never)
    server.respond('thread/unsubscribe', { status: 'unsubscribed' } as never)
    const { runtime } = build({ server, spec: { sessionId: 'child' } })
    const result = await runtime.start()
    expect(result.state).toBe('created')
    expect(result.sessionId).not.toBe('child')
    // Resuming subscribed the connection to the child; it lets go.
    expect(server.requests('thread/unsubscribe').map((r) => r.params)).toEqual([
      { threadId: 'child' },
    ])

    const strict = build({ server, spec: { sessionId: 'child', load: 'require' } })
    await expect(strict.runtime.start()).rejects.toBeInstanceOf(SessionUnknownError)
    runtime.dispose()
  })
})

describe('CodexSessionRuntime subagents, review regressions', () => {
  it('cancels the card of a running child that is closed, and forgets it', async () => {
    const { server, runtime, events, turn, prompt } = await running()
    const closed = turn.thread.child()
    const gone = turn.thread.child()
    const shut = turn.thread.child()
    const childTurns = [closed, gone, shut].map((child) => {
      turn.spawnSubagent(child)
      return child.turn().started()
    })
    await vi.waitFor(() => expect(runtime.busy).toBe(true))
    const close = collabCall('closeAgent', turn.threadId, [closed.id])
    turn.itemStarted(close)
    turn.itemCompleted({ ...close, status: 'completed' })
    server.notify('thread/closed', { threadId: gone.id })
    const list = collabCall('listAgents', turn.threadId, [])
    turn.itemStarted(list)
    // A `shutdown` state for a child running no turn here.
    childTurns[2]!.completed()
    await tick()
    turn.itemCompleted({
      ...list,
      status: 'completed',
      agentsStates: { [shut.id]: { status: 'shutdown', message: null } },
    })
    await tick()
    const last = (id: string) =>
      subtasks(events)
        .filter((u) => u.taskId === id && u.status)
        .at(-1)
    expect(last(closed.id)).toMatchObject({ status: 'cancelled' })
    expect(last(gone.id)).toMatchObject({ status: 'cancelled' })
    expect(last(shut.id)).toMatchObject({ status: 'completed' })
    expect(runtime.busy).toBe(false)
    // Forgotten: a stop has nothing of theirs to interrupt.
    interruptible(server, () => [turn])
    await runtime.cancel()
    await prompt
    expect(server.requests('turn/interrupt').map((r) => r.params.threadId)).toEqual([turn.threadId])
  })

  it('gives a messaged thread Codex never named no card, and does not count it', async () => {
    const { runtime, events, turn, prompt } = await running()
    const phantom = turn.thread.child()
    const send = collabCall('sendInput', turn.threadId, [phantom.id])
    turn.itemStarted(send)
    turn.itemCompleted({
      ...send,
      status: 'failed',
      agentsStates: { [phantom.id]: { status: 'notFound', message: null } },
    })
    const quiet = turn.thread.child({ agentNickname: 'quiet' })
    const reach = collabCall('sendInput', turn.threadId, [quiet.id])
    turn.itemStarted(reach)
    turn.itemCompleted({ ...reach, status: 'completed' })
    await tick()
    expect(subtasks(events)).toEqual([])
    expect(runtime.busy).toBe(false)
    // Once it runs, it is real: a card, counted, and its stream kept apart.
    const quietTurn = quiet.turn().started()
    quietTurn.agentMessage('hidden')
    await vi.waitFor(() => expect(runtime.busy).toBe(true))
    expect(subtasks(events)).toMatchObject([
      { taskId: quiet.id, status: 'running', toolCallId: reach.id },
    ])
    quietTurn.completed()
    turn.completed()
    await prompt
    expect(texts(events)).toBe('')
    expect(runtime.busy).toBe(false)
  })

  it('shows a known child as running when a collab call sees it running', async () => {
    const { runtime, events, turn } = await running()
    const child = turn.thread.child()
    const send = collabCall('followupTask', turn.threadId, [child.id])
    turn.itemStarted(send)
    turn.itemCompleted({
      ...send,
      status: 'completed',
      agentsStates: { [child.id]: { status: 'pendingInit', message: null } },
    })
    await vi.waitFor(() => expect(runtime.busy).toBe(true))
    expect(subtasks(events)).toMatchObject([{ taskId: child.id, status: 'pending' }])
    runtime.dispose()
  })

  it('resolves a stop without waiting for children that will not stop', async () => {
    const { server, runtime, turn, prompt } = await running()
    const stubborn = turn.thread.child()
    turn.spawnSubagent(stubborn)
    stubborn.turn().started()
    interruptible(server, () => [turn])
    const started = Date.now()
    await runtime.cancel()
    await prompt
    // The default bound is 10 s; the stop resolved long before it.
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(server.requests('turn/interrupt').map((r) => r.params.threadId)).toEqual([
      turn.threadId,
      stubborn.id,
    ])
    expect(runtime.busy).toBe(true)

    // A new prompt ends the look: its own children are left alone.
    let next: FakeCodexTurn | undefined
    server.serveThreads((t) => (next = t))
    const second = runtime.prompt({ prompt: PROMPT })
    await vi.waitFor(() => expect(next).toBeDefined())
    const fresh = next!.thread.child()
    next!.spawnSubagent(fresh)
    fresh.turn().started()
    await tick()
    expect(server.requests('turn/interrupt')).toHaveLength(2)
    next!.completed()
    await second
    runtime.dispose()
  })

  it('reports children of a failed turn, and late ones, as in the background', async () => {
    const { events, turn, prompt } = await running()
    const child = turn.thread.child()
    turn.spawnSubagent(child)
    const childTurn = child.turn().started()
    turn.failed('The model is overloaded')
    await expect(prompt).rejects.toThrow(/overloaded/)
    expect(subtasks(events)).toContainEqual({ taskId: child.id, background: true })
    // Its own child, started once the parent had no turn: background at once.
    const grandchild = child.child()
    childTurn.spawnSubagent(grandchild)
    await tick()
    expect(subtasks(events).find((u) => u.taskId === grandchild.id)).toMatchObject({
      status: 'running',
      depth: 2,
      parentTaskId: child.id,
      background: true,
    })
  })

  it('settles a child whose whole turn ran before an older spawn call named it', async () => {
    const { runtime, events, turn, prompt } = await running()
    const child = turn.thread.child()
    const spawn = collabCall('spawnAgent', turn.threadId, [], { prompt: 'Be quick' })
    turn.itemStarted(spawn)
    const childTurn = child.turn().started()
    childTurn.agentMessage('done')
    childTurn.completed()
    turn.itemCompleted({ ...spawn, status: 'completed', receiverThreadIds: [child.id] })
    await tick()
    expect(subtasks(events)).toMatchObject([
      { taskId: child.id, toolCallId: spawn.id, prompt: 'Be quick', status: 'completed' },
    ])
    expect(runtime.busy).toBe(false)
    turn.completed()
    await prompt
  })
})

describe('CodexSubagents', () => {
  const tracker = () => {
    const outputs: CodexSubagentOutput[] = []
    const subagents = new CodexSubagents(
      () => 'root',
      () => true,
      (output) => outputs.push(output),
    )
    const spawn = (threadId: string) =>
      subagents.item(
        'root',
        {
          type: 'subAgentActivity',
          id: `call_${threadId}`,
          kind: 'started',
          agentThreadId: threadId,
          agentPath: `/root/${threadId}`,
          model: null,
          reasoningEffort: null,
        },
        'started',
        true,
      )
    const turnStarted = (threadId: string, turnId: string) =>
      subagents.notification('turn/started', threadId, { threadId, turn: { id: turnId } })
    return { subagents, outputs, spawn, turnStarted }
  }

  it('wakes a stop on registrations and turns, not on deltas', async () => {
    const { subagents, spawn, turnStarted } = tracker()
    spawn('c')
    turnStarted('c', 't')
    let woke = false
    void subagents.changed().then(() => (woke = true))
    subagents.notification('item/agentMessage/delta', 'c', { threadId: 'c', delta: 'x' })
    subagents.notification('thread/tokenUsage/updated', 'c', {
      threadId: 'c',
      tokenUsage: { total: { totalTokens: 1 }, last: { totalTokens: 1 } },
    })
    await tick()
    expect(woke).toBe(false)
    subagents.notification('turn/completed', 'c', {
      threadId: 'c',
      turn: { id: 't', status: 'completed' },
    })
    await tick()
    expect(woke).toBe(true)
  })

  it('forgets a closed child and never offers its turn to a stop', () => {
    const { subagents, spawn, turnStarted } = tracker()
    spawn('c')
    turnStarted('c', 't')
    expect(subagents.activeTurns()).toEqual([{ threadId: 'c', turnId: 't' }])
    subagents.notification('thread/closed', 'c', { threadId: 'c' })
    expect(subagents.has('c')).toBe(false)
    expect(subagents.activeTurns()).toEqual([])
    expect(subagents.running).toBe(false)
  })
})

describe('CodexSessionRuntime subagents against recordings', () => {
  it('replays the recorded subagent: a card, a waiting row, and the parent’s own answer', async () => {
    const server = new ReplayCodexAppServer('subagent')
    server.respond('model/list', MODELS as never)
    const { runtime, events } = build({ server })
    await runtime.start()
    await runtime.prompt({ prompt: PROMPT })
    await server.done
    expect(server.unmatched).toEqual([])
    expect(texts(events)).toBe('42')
    const childId = '01a1f79f-ea30-7dc1-8b96-5459a7caafb8'
    const updates = subtasks(events)
    expect(updates[0]).toMatchObject({
      taskId: childId,
      toolCallId: 'call_6e6c8a2f42354775aecfd81154575a08',
      title: 'exact_reply',
      modelId: 'gpt-6-luna',
      status: 'running',
    })
    expect(updates.at(-1)).toMatchObject({ taskId: childId, status: 'completed', resultText: '42' })
    expect(events.filter((e) => e.event === 'tool_call')).toMatchObject([
      { data: { title: 'Waiting for subagents', status: 'in_progress' } },
    ])
    expect(events.filter((e) => e.event === 'tool_call_update')).toMatchObject([
      { data: { status: 'completed' } },
    ])
    expect(events.filter((e) => e.event === 'prompt_completed')).toHaveLength(1)
    expect(runtime.busy).toBe(false)
    runtime.dispose()
  })

  it('replays the recorded stop: the parent’s turn, then the child’s', async () => {
    const server = new ReplayCodexAppServer('interrupt-with-child')
    server.respond('model/list', MODELS as never)
    const { runtime, events } = build({ server })
    await runtime.start()
    const prompt = runtime.prompt({ prompt: PROMPT })
    // Stopped where the recording was: the child's `sleep 30` running.
    await vi.waitFor(() => expect(server.waitingFor).toMatchObject({ method: 'turn/interrupt' }))
    expect(runtime.busy).toBe(true)
    await runtime.cancel()
    await prompt
    await server.done
    expect(server.unmatched).toEqual([])
    const parentId = '01a1f7a0-8cbb-7bc1-ba6f-ec9544adcddd'
    const childId = '01a1f7a0-98a8-75f0-a909-b2ce0e38b83d'
    expect(
      server.matched.filter((m) => 'method' in m.actual && m.actual.method === 'turn/interrupt'),
    ).toMatchObject([
      {
        actual: { params: { threadId: parentId, turnId: '01a1f7a0-8d0d-7e20-8cd6-64c9890148fc' } },
      },
      { actual: { params: { threadId: childId, turnId: '01a1f7a0-98da-7ef1-a1e8-f80b1d29010a' } } },
    ])
    expect(events.find((e) => e.event === 'prompt_completed')).toMatchObject({
      data: { stopReason: 'cancelled' },
    })
    expect(subtasks(events).at(-1)).toMatchObject({ taskId: childId, status: 'interrupted' })
    expect(runtime.busy).toBe(false)
    runtime.dispose()
  })
})
