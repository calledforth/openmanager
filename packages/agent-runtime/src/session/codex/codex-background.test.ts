import { describe, expect, it, vi } from 'vitest'
import type { BackgroundTask } from '@agentpack/contract'
import type { BackendEvent } from '../../backends/Backend.js'
import { InteractionBroker } from '../../core/InteractionBroker.js'
import { PermissionBroker } from '../../core/PermissionBroker.js'
import { codex } from '../../providers/codex.js'
import { CodexAppServerClient } from './CodexAppServerClient.js'
import { CodexSessionRuntime } from './CodexSessionRuntime.js'
import type { CodexStarter } from './start.js'
import { codexBuilders, FakeCodexAppServer, type FakeCodexTurn } from './testing/index.js'

const PROMPT = { text: 'hi', blocks: [{ type: 'text' as const, text: 'hi' }] }

type Terminals = Map<string, { threadId: string; itemId: string; command: string }>

/** A runtime on a fake app-server that serves background terminals from
 * `terminals`. Each turn is handed to the test once Codex announces it. */
function build(options: { supportsBackgroundTasks?: boolean; serve?: boolean } = {}) {
  const server = new FakeCodexAppServer()
  const terminals: Terminals = new Map()
  const turns: FakeCodexTurn[] = []
  server.respond('model/list', { data: [], nextCursor: null })
  server.serveThreads((turn) => turns.push(turn))
  if (options.serve !== false) server.serveBackgroundTerminals(terminals)
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
  const config = {
    ...codex,
    capabilities: {
      ...codex.capabilities,
      supportsBackgroundTasks: options.supportsBackgroundTasks ?? true,
    },
  }
  const events: BackendEvent[] = []
  const runtime = new CodexSessionRuntime(
    { threadId: 'thread-1', providerId: 'codex', cwd: '/work' },
    {
      config,
      host: { log },
      permissions: new PermissionBroker(),
      interactions: new InteractionBroker(),
      start,
      platform: 'linux',
      timeouts: { interruptGraceMs: 200 },
    },
  )
  runtime.events((event) => events.push(event))
  const rosters = () =>
    events
      .filter((event) => event.event === 'background_tasks_update')
      .map((event) => (event.data as { tasks: BackgroundTask[] }).tasks)
  return { server, runtime, events, terminals, turns, log, rosters }
}

/** A prompt whose turn starts `sleep 300` (process 77) and ends with it
 * still running, as Codex reports it: the command's item never completes
 * within the turn, and the process is retained. */
async function leaveRunning(harness: ReturnType<typeof build>, sessionId: string) {
  const { runtime, terminals, turns } = harness
  const prompt = runtime.prompt({ prompt: PROMPT })
  await vi.waitFor(() => expect(turns).toHaveLength(1))
  const turn = turns[0]!
  turn.started()
  const item = turn.itemStarted(
    codexBuilders.commandExecutionItem('sleep 300', { id: 'exec-sleep', processId: '77' }),
  )
  terminals.set('77', { threadId: sessionId, itemId: item.id, command: 'sleep 300' })
  turn.completed()
  await prompt
  return { turn, item }
}

describe('Codex background terminals', () => {
  it('lists a command a turn left running as a shell task, until it ends', async () => {
    const harness = build()
    const { server, runtime, terminals, rosters } = harness
    const { sessionId } = await runtime.start()
    expect(runtime.busy).toBe(false)
    const { turn, item } = await leaveRunning(harness, sessionId)

    await vi.waitFor(() =>
      expect(rosters()).toEqual([[{ taskId: '77', kind: 'shell', description: 'sleep 300' }]]),
    )
    expect(server.requests('thread/backgroundTerminals/list')[0]!.params).toEqual({ threadId: sessionId })
    expect(runtime.busy).toBe(true)

    // It ends by itself: Codex completes its item late, under the old turn.
    terminals.delete('77')
    turn.itemCompleted({ ...item, status: 'completed', exitCode: 0 })
    await vi.waitFor(() => expect(rosters().at(-1)).toEqual([]))
    expect(runtime.busy).toBe(false)
  })

  it('asks for nothing, then or at the stop, when no turn left a command running', async () => {
    const { server, runtime, turns } = build()
    await runtime.start()
    const prompt = runtime.prompt({ prompt: PROMPT })
    await vi.waitFor(() => expect(turns).toHaveLength(1))
    turns[0]!.started().command('npm test', { output: 'ok\n' })
    turns[0]!.completed()
    await prompt
    await runtime.stop({ reason: 'disposed' })
    expect(server.requests('thread/backgroundTerminals/list')).toEqual([])
    expect(server.requests('thread/backgroundTerminals/terminate')).toEqual([])
  })

  it('stops a listed terminal with thread/backgroundTerminals/terminate', async () => {
    const harness = build()
    const { server, runtime, rosters } = harness
    const { sessionId } = await runtime.start()
    await leaveRunning(harness, sessionId)
    await vi.waitFor(() => expect(rosters()).toHaveLength(1))

    await runtime.stopBackgroundTasks(['77'])
    expect(server.requests('thread/backgroundTerminals/terminate').map((r) => r.params)).toEqual([
      { threadId: sessionId, processId: '77' },
    ])
    expect(rosters().at(-1)).toEqual([])
    expect(runtime.busy).toBe(false)
  })

  it('skips ids it does not list, and stops every listed one when none is named', async () => {
    const harness = build()
    const { server, runtime, terminals, rosters } = harness
    const { sessionId } = await runtime.start()
    await leaveRunning(harness, sessionId)
    await vi.waitFor(() => expect(rosters()).toHaveLength(1))

    await runtime.stopBackgroundTasks(['999'])
    expect(server.requests('thread/backgroundTerminals/terminate')).toEqual([])
    expect(terminals.size).toBe(1)

    await runtime.stopBackgroundTasks()
    expect(server.requests('thread/backgroundTerminals/terminate')).toHaveLength(1)
    expect(terminals.size).toBe(0)
  })

  it('counts a process already gone and a thread Codex no longer holds as stopped', async () => {
    const harness = build()
    const { server, runtime, terminals, rosters } = harness
    const { sessionId } = await runtime.start()
    await leaveRunning(harness, sessionId)
    await vi.waitFor(() => expect(rosters()).toHaveLength(1))

    // Ended between the list and the stop: `terminated: false`.
    server.respond('thread/backgroundTerminals/terminate', { terminated: false }, { times: 1 })
    await expect(runtime.stopBackgroundTasks(['77'])).resolves.toBeUndefined()

    // The thread is gone (probed: `-32600 thread not found: …`).
    server.fail('thread/backgroundTerminals/terminate', -32600, `thread not found: ${sessionId}`, { times: 1 })
    await expect(runtime.stopBackgroundTasks(['77'])).resolves.toBeUndefined()
    expect(terminals.size).toBe(1)

    // Anything else is a stop that did not happen.
    server.fail('thread/backgroundTerminals/terminate', -32603, 'boom', { times: 1 })
    await expect(runtime.stopBackgroundTasks(['77'])).rejects.toThrow('boom')
  })

  it('takes a thread Codex does not hold as having no terminals', async () => {
    const harness = build()
    const { server, runtime, rosters } = harness
    const { sessionId } = await runtime.start()
    server.fail('thread/backgroundTerminals/list', -32600, `thread not found: ${sessionId}`, { times: 1 })
    await leaveRunning(harness, sessionId)
    await vi.waitFor(() => expect(server.requests('thread/backgroundTerminals/list')).toHaveLength(1))
    expect(rosters()).toEqual([])
    expect(runtime.busy).toBe(false)
  })

  it('ends every terminal the thread retains when the session stops, before the process', async () => {
    const harness = build()
    const { server, runtime, terminals, turns, rosters } = harness
    const { sessionId } = await runtime.start()
    await leaveRunning(harness, sessionId)
    await vi.waitFor(() => expect(rosters()).toHaveLength(1))

    // A second turn is running another command when the session stops. Its
    // process is not listed yet: the stop reads the list afresh.
    server.respond('turn/interrupt', {}, { after: () => turns[1]!.interrupted() })
    const prompt = runtime.prompt({ prompt: PROMPT }).catch(() => undefined)
    await vi.waitFor(() => expect(turns).toHaveLength(2))
    turns[1]!.started()
    turns[1]!.itemStarted(codexBuilders.commandExecutionItem('npm run dev', { id: 'exec-dev', processId: '78' }))
    terminals.set('78', { threadId: sessionId, itemId: 'exec-dev', command: 'npm run dev' })

    await runtime.stop({ reason: 'disposed' })
    await prompt
    expect(
      server
        .requests('thread/backgroundTerminals/terminate')
        .map((r) => r.params.processId)
        .sort(),
    ).toEqual(['77', '78'])
    expect(terminals.size).toBe(0)
    expect(rosters().at(-1)).toEqual([])
    expect(runtime.busy).toBe(false)
  })

  it('stops a session whose terminals are already gone', async () => {
    const harness = build()
    const { server, runtime, rosters } = harness
    const { sessionId } = await runtime.start()
    await leaveRunning(harness, sessionId)
    await vi.waitFor(() => expect(rosters()).toHaveLength(1))
    server.respond('thread/backgroundTerminals/terminate', { terminated: false })

    await expect(runtime.stop({ reason: 'disposed' })).resolves.toMatchObject({ expected: true })
    expect(rosters().at(-1)).toEqual([])
  })

  it('ends the running commands of a turn the user stops, as their rows say', async () => {
    const { server, runtime, terminals, turns } = build()
    const { sessionId } = await runtime.start()
    server.respond('turn/interrupt', {}, { after: () => turns[0]!.interrupted() })
    const prompt = runtime.prompt({ prompt: PROMPT })
    await vi.waitFor(() => expect(turns).toHaveLength(1))
    turns[0]!.started()
    turns[0]!.itemStarted(codexBuilders.commandExecutionItem('sleep 300', { id: 'exec-sleep', processId: '77' }))
    terminals.set('77', { threadId: sessionId, itemId: 'exec-sleep', command: 'sleep 300' })

    await runtime.cancel()
    await prompt
    await vi.waitFor(() =>
      expect(server.requests('thread/backgroundTerminals/terminate').map((r) => r.params)).toEqual([
        { threadId: sessionId, processId: '77' },
      ]),
    )
    expect(terminals.size).toBe(0)
  })

  it.each([
    [-32600, 'thread/backgroundTerminals/list requires experimentalApi capability'],
    [-32600, 'Invalid request: unknown variant `thread/backgroundTerminals/list`, expected one of …'],
    [-32601, 'method not found'],
  ])('shows none, and asks once, when Codex refuses the list (%i %s)', async (code, message) => {
    const harness = build({ serve: false })
    const { server, runtime, log, rosters, turns } = harness
    const { sessionId } = await runtime.start()
    server.fail('thread/backgroundTerminals/list', code, message)
    await leaveRunning(harness, sessionId)
    await vi.waitFor(() => expect(server.requests('thread/backgroundTerminals/list')).toHaveLength(1))
    expect(rosters()).toEqual([])
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/refused to list/) }))

    // A later turn that leaves another command running asks no more.
    const next = runtime.prompt({ prompt: PROMPT })
    await vi.waitFor(() => expect(turns).toHaveLength(2))
    turns[1]!.started()
    turns[1]!.itemStarted(codexBuilders.commandExecutionItem('npm run dev', { processId: '78' }))
    turns[1]!.completed()
    await next
    await runtime.stop({ reason: 'disposed' })
    expect(server.requests('thread/backgroundTerminals/list')).toHaveLength(1)
    expect(server.requests('thread/backgroundTerminals/terminate')).toEqual([])
  })

  it('never brings back a command that ended while the list was out', async () => {
    const harness = build()
    const { server, runtime, terminals, rosters } = harness
    const { sessionId } = await runtime.start()
    // The first list is answered as Codex saw it when asked, after the
    // command's completion has already arrived.
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    server.respond(
      'thread/backgroundTerminals/list',
      async () => {
        const stale = [...terminals.entries()].map(([processId, terminal]) => ({
          itemId: terminal.itemId,
          processId,
          command: terminal.command,
          cwd: '/work',
          osPid: null,
          cpuPercent: null,
          rssKb: null,
        }))
        await held
        return { data: stale, nextCursor: null }
      },
      { times: 1 },
    )
    const { turn, item } = await leaveRunning(harness, sessionId)
    await vi.waitFor(() => expect(server.requests('thread/backgroundTerminals/list')).toHaveLength(1))
    terminals.delete('77')
    turn.itemCompleted({ ...item, status: 'completed', exitCode: 0 })
    // Let the completion arrive before the stale answer does.
    await new Promise((resolve) => setTimeout(resolve, 20))
    release()

    await vi.waitFor(() => expect(server.requests('thread/backgroundTerminals/list')).toHaveLength(2))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(rosters()).toEqual([])
    expect(runtime.busy).toBe(false)
  })

  it('reads a list that failed again, and keeps showing the background tasks', async () => {
    const harness = build()
    const { server, runtime, rosters, log } = harness
    const { sessionId } = await runtime.start()
    // A transient error, not a Codex without the method.
    server.fail('thread/backgroundTerminals/list', -32603, 'internal error', { times: 1 })
    await leaveRunning(harness, sessionId)

    await vi.waitFor(
      () => expect(rosters()).toEqual([[{ taskId: '77', kind: 'shell', description: 'sleep 300' }]]),
      { timeout: 3_000 },
    )
    expect(server.requests('thread/backgroundTerminals/list')).toHaveLength(2)
    expect(log).not.toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/refused to list/) }))
    // Still stoppable.
    await runtime.stopBackgroundTasks(['77'])
    expect(server.requests('thread/backgroundTerminals/terminate')).toHaveLength(1)
  })

  it('reads the list again when the thread is lost between turns', async () => {
    const harness = build()
    const { server, runtime, rosters } = harness
    const { sessionId } = await runtime.start()
    await leaveRunning(harness, sessionId)
    await vi.waitFor(() => expect(rosters()).toHaveLength(1))

    server.fail('thread/backgroundTerminals/list', -32600, `thread not found: ${sessionId}`, { times: 1 })
    server.notify('thread/closed', { threadId: sessionId })
    await vi.waitFor(() => expect(rosters().at(-1)).toEqual([]))
    expect(runtime.busy).toBe(false)
  })

  it('settles a failed turn’s running command as running on, as the list shows it', async () => {
    const { runtime, terminals, turns, events, rosters } = build()
    const { sessionId } = await runtime.start()
    const prompt = runtime.prompt({ prompt: PROMPT })
    await vi.waitFor(() => expect(turns).toHaveLength(1))
    turns[0]!.started()
    turns[0]!.itemStarted(codexBuilders.commandExecutionItem('npm run dev', { id: 'exec-dev', processId: '78' }))
    terminals.set('78', { threadId: sessionId, itemId: 'exec-dev', command: 'npm run dev' })
    turns[0]!.failed('model overloaded')
    await expect(prompt).rejects.toThrow()

    const settled = events
      .filter((e) => e.event === 'tool_call_update')
      .map((e) => e.data as { toolCallId: string; status?: string })
    expect(settled).toContainEqual(expect.objectContaining({ toolCallId: 'exec-dev', status: 'completed' }))
    const note = events.find(
      (e) => e.event === 'tool_call_content' && (e.data as { toolCallId: string }).toolCallId === 'exec-dev',
    )
    expect(JSON.stringify(note?.data)).toContain('Still running in the background')
    await vi.waitFor(() =>
      expect(rosters()).toEqual([[{ taskId: '78', kind: 'shell', description: 'npm run dev' }]]),
    )
  })

  it('lists and stops nothing for a provider without supportsBackgroundTasks', async () => {
    const harness = build({ supportsBackgroundTasks: false })
    const { server, runtime, rosters } = harness
    const { sessionId } = await runtime.start()
    await leaveRunning(harness, sessionId)
    await runtime.stopBackgroundTasks()
    await runtime.stop({ reason: 'disposed' })
    expect(server.requests('thread/backgroundTerminals/list')).toEqual([])
    expect(server.requests('thread/backgroundTerminals/terminate')).toEqual([])
    expect(rosters()).toEqual([])
  })
})
