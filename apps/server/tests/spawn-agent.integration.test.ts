import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import type { AgentRuntime } from '@agentpack/runtime/node'
import {
  ProofResponseSchemas,
  type CommandEnvelope,
  type ProofEvent,
  type Subagent,
} from '@openmanager/protocol/node'
import { runMigrations } from '../src/db/migrate.js'
import { MIGRATIONS } from '../src/db/migrations.js'
import { createPersistentEventService } from '../src/event-service.js'
import { createThreadService, type WorkspaceRuntimeResolver } from '../src/thread-service.js'
import { reconcileAfterRestart } from '../src/db/boot-reconcile.js'
import { createSpawnAgentTools } from '../src/subagents/spawn-tools.js'

/**
 * `spawn_agent` end to end on the thread service (docs/decisions/subagents.md,
 * The spawn tool): a child of ours is an ordinary session on its own provider,
 * its card follows its turns, and a parent that has not waited on it is told
 * through its queue when it finishes.
 */

const WORKSPACE = '/workspace/project'
const ENVIRONMENT = 'environment-1'
const resolver: WorkspaceRuntimeResolver = (workspaceId) =>
  workspaceId === WORKSPACE
    ? { providerId: 'claude', providers: ['claude', 'opencode', 'codex'], cwd: WORKSPACE }
    : undefined

type PromptArgs = {
  threadId: string
  providerId: string
  userMessageId: string
  prompt: { text: string }
}

function setup() {
  const database = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true })
  runMigrations(database, MIGRATIONS)
  database.exec(
    `INSERT INTO workspaces (workspace_id, name, path, created_at, updated_at)
     VALUES ('${WORKSPACE}', 'Project', '${WORKSPACE}', 1, 1)`,
  )
  const published: ProofEvent[] = []
  const events = createPersistentEventService(database, (record) => published.push(record.event))
  /** Each prompt runs until the test ends it, by thread. */
  const running = new Map<string, () => void>()
  const prompts: PromptArgs[] = []
  let sessions = 0
  const runtime = {
    ensureSession: vi.fn(async () => ({
      sessionId: `provider-${(sessions += 1)}`,
      state: 'created',
    })),
    prompt: vi.fn(
      (args: PromptArgs) =>
        new Promise<void>((resolve) => {
          prompts.push(args)
          running.set(args.threadId, resolve)
        }),
    ),
    cancel: vi.fn(async (args: { threadId: string }) => running.get(args.threadId)?.()),
    respondPermission: vi.fn(),
    stopSubtask: vi.fn(async () => undefined),
  }
  const make = () => {
    const created = createThreadService(
    runtime as unknown as Pick<
      AgentRuntime,
      'ensureSession' | 'prompt' | 'cancel' | 'respondPermission'
    >,
    { rejection: () => undefined },
    events.append,
    undefined,
    resolver,
    {
      database,
      flush: events.flush,
      appendAtomic: events.appendAtomic,
      finalizeNow: events.finalizeNow,
      spawnProviders: () => [
        { providerId: 'opencode', name: 'OpenCode', available: true, models: [] },
        {
          providerId: 'codex',
          name: 'Codex',
          available: true,
          models: [{ modelId: 'gpt-5.5', name: 'GPT-5.5' }],
          defaultModelId: 'gpt-5.5',
        },
      ],
    },
  )
    created.setEnvironmentId(ENVIRONMENT)
    return created
  }
  let service = make()
  /** A new service on the same rows is a new process, booted as the host boots. */
  const restart = () => {
    events.flush()
    reconcileAfterRestart(database, events.repository, ENVIRONMENT)
    service = make()
  }
  const dispatch = (name: string, payload: CommandEnvelope['payload']) =>
    service.dispatch({ type: 'command', requestId: name.replaceAll('.', '-'), name, payload })
  const parent = ProofResponseSchemas['session.create'].parse(
    dispatch('session.create', {
      environmentId: ENVIRONMENT,
      workspaceId: WORKSPACE,
      providerId: 'claude',
      title: 'Parent',
    }),
  ).payload.thread

  let seq = 0
  const emit = (
    threadId: string,
    providerId: string,
    event: Record<string, unknown>,
    messageId?: string,
  ) =>
    service.onRuntimeEvent({
      id: `runtime-${(seq += 1)}`,
      seq,
      timestamp: new Date().toISOString(),
      providerId,
      threadId,
      workspaceId: WORKSPACE,
      ...(messageId ? { messageId } : {}),
      ...event,
    } as Parameters<typeof service.onRuntimeEvent>[0])

  /** Start a prompted turn: the provider took it. */
  const promptStarted = (args: PromptArgs) =>
    emit(
      args.threadId,
      args.providerId,
      {
        category: 'lifecycle',
        event: 'prompt_started',
        data: { prompt: args.prompt.text, userMessageId: args.userMessageId },
      },
      `run-${args.userMessageId}`,
    )
  /** End a prompted turn the way a provider does. */
  const finish = (args: PromptArgs) => {
    emit(
      args.threadId,
      args.providerId,
      { category: 'lifecycle', event: 'prompt_completed', data: { stopReason: 'end_turn' } },
      `run-${args.userMessageId}`,
    )
    running.get(args.threadId)?.()
  }
  const promptOn = async (threadId: string, nth = 0) => {
    await vi.waitFor(() =>
      expect(prompts.filter((args) => args.threadId === threadId).length).toBeGreaterThan(nth),
    )
    return prompts.filter((args) => args.threadId === threadId)[nth]!
  }

  const call = (name: string, input: Record<string, unknown>) =>
    createSpawnAgentTools(service.spawnHost)
      .find((tool) => tool.name === name)!
      .call(input, { threadId: parent.threadId, providerId: 'claude' })

  const records = (threadId: string): Subagent[] =>
    published
      .filter(
        (event) =>
          event.name === 'subagent.updated' &&
          (event.scope as { threadId?: string }).threadId === threadId,
      )
      .map((event) => (event.payload as { subagent: Subagent }).subagent)
  const latest = (threadId: string) => records(threadId).at(-1)!

  /** The parent's turn, running, with a `spawn_agent` call the card should claim. */
  const parentTurn = async () => {
    dispatch('turn.send', { ...parent, text: 'Get a second opinion' })
    const args = await promptOn(parent.threadId)
    promptStarted(args)
    emit(
      parent.threadId,
      'claude',
      {
        category: 'tool',
        event: 'tool_call',
        data: {
          toolCallId: 'toolu_spawn',
          title: 'spawn_agent',
          toolName: 'mcp__openmanager__spawn_agent',
          status: 'in_progress',
        },
      },
      `run-${args.userMessageId}`,
    )
    return args
  }

  return {
    database,
    published,
    get service() {
      return service
    },
    restart,
    dispatch,
    events,
    parent,
    emit,
    promptStarted,
    finish,
    promptOn,
    call,
    records,
    latest,
    parentTurn,
    runtime,
  }
}

describe('spawn_agent on the thread service', () => {
  it('files an ordinary promptable child on the other provider, with a card in place of the call', async () => {
    const t = setup()
    await t.parentTurn()
    const result = await t.call('spawn_agent', {
      provider: 'opencode',
      prompt: 'Review src/parser.ts',
      title: 'Review the parser',
    })
    expect(result.isError).toBeUndefined()
    const card = t.latest(t.parent.threadId)
    expect(card).toMatchObject({
      origin: 'openmanager',
      providerId: 'opencode',
      title: 'Review the parser',
      status: 'running',
      promptable: true,
      stoppable: true,
      background: true,
      depth: 1,
    })
    // The card claims the call; a client shows it in the call's place.
    const toolUpdates = t.published.filter((event) => event.name === 'tool.updated')
    expect(
      toolUpdates.map((event) => (event.payload as { toolCallId: string }).toolCallId),
    ).toContain(card.toolCallId)
    const row = t.database
      .prepare(
        'SELECT provider_id, parent_session_id, subagent_origin, subagent_promptable FROM sessions WHERE session_id = ?',
      )
      .get(card.childSessionId!) as Record<string, unknown>
    expect(row).toMatchObject({
      provider_id: 'opencode',
      parent_session_id: t.parent.sessionId,
      subagent_origin: 'openmanager',
    })
    const childThread = (
      t.database
        .prepare('SELECT thread_id FROM threads WHERE session_id = ?')
        .get(card.childSessionId!) as {
        thread_id: string
      }
    ).thread_id
    const childPrompt = await t.promptOn(childThread)
    expect(childPrompt.providerId).toBe('opencode')
    expect(childPrompt.prompt.text).toBe('Review src/parser.ts')
    const started = t.published.find(
      (event) =>
        event.name === 'turn.started' &&
        (event.scope as { threadId?: string }).threadId === childThread,
    )
    expect((started?.payload as { turn: { origin?: string } }).turn.origin).toBe('delegated')
  })

  it('keeps the title the parent agent gave a child when its provider names the session', async () => {
    const t = setup()
    await t.parentTurn()
    await t.call('spawn_agent', { provider: 'opencode', prompt: 'Review auth', title: 'Cursor: auth' })
    const child = t.latest(t.parent.threadId).childSessionId!
    const childThread = (
      t.database.prepare('SELECT thread_id FROM threads WHERE session_id = ?').get(child) as {
        thread_id: string
      }
    ).thread_id
    const prompt = await t.promptOn(childThread)
    t.promptStarted(prompt)
    // Cursor names a session from its first prompt (seen live); any provider may.
    t.emit(
      childThread,
      'opencode',
      { category: 'lifecycle', event: 'session_info_update', data: { title: 'Session Leak Review' } },
      `run-${prompt.userMessageId}`,
    )
    const row = t.database
      .prepare('SELECT title FROM sessions WHERE session_id = ?')
      .get(child) as { title: string }
    expect(row.title).toBe('Cursor: auth')
  })

  it('names on the card the model a child asked for none of runs on, as its provider reports it', async () => {
    const t = setup()
    await t.parentTurn()
    await t.call('spawn_agent', { provider: 'opencode', prompt: 'Review auth', title: 'Review' })
    expect(t.latest(t.parent.threadId).modelId).toBeUndefined()
    const child = t.latest(t.parent.threadId).childSessionId!
    const childThread = (
      t.database.prepare('SELECT thread_id FROM threads WHERE session_id = ?').get(child) as {
        thread_id: string
      }
    ).thread_id
    t.emit(childThread, 'opencode', {
      category: 'lifecycle',
      event: 'session_created',
      data: {
        sessionId: 'oc-1',
        models: { currentModelId: 'grok-4.6', availableModels: [] },
      },
    })
    expect(t.latest(t.parent.threadId).modelId).toBe('grok-4.6')
  })

  it('settles with its answer and wakes a parent that did not wait, once its turn ends', async () => {
    const t = setup()
    const parentArgs = await t.parentTurn()
    await t.call('spawn_agent', { provider: 'opencode', prompt: 'Review', title: 'Review' })
    const card = t.latest(t.parent.threadId)
    const childThread = (
      t.database
        .prepare('SELECT thread_id FROM threads WHERE session_id = ?')
        .get(card.childSessionId!) as {
        thread_id: string
      }
    ).thread_id
    const child = await t.promptOn(childThread)
    t.promptStarted(child)
    t.emit(
      childThread,
      'opencode',
      {
        category: 'tool',
        event: 'tool_call',
        data: { toolCallId: 'read-1', title: 'Read src/parser.ts', status: 'completed' },
      },
      `run-${child.userMessageId}`,
    )
    t.emit(
      childThread,
      'opencode',
      {
        category: 'stream',
        event: 'agent_message_chunk',
        data: { content: { type: 'text', text: 'Looks fine.' } },
      },
      `run-${child.userMessageId}`,
    )
    await vi.waitFor(() => expect(t.latest(t.parent.threadId).activity).toBe('Read src/parser.ts'))
    t.finish(child)
    await vi.waitFor(() =>
      expect(t.latest(t.parent.threadId)).toMatchObject({
        status: 'completed',
        result: 'Looks fine.',
        stats: { toolCalls: 1 },
      }),
    )
    // The parent is still in its turn: the notice waits in its queue.
    const queued = () =>
      t.published
        .filter(
          (event) =>
            event.name === 'thread.queue.updated' &&
            (event.scope as { threadId?: string }).threadId === t.parent.threadId,
        )
        .at(-1)?.payload as { items: { origin?: string; text: string }[] } | undefined
    await vi.waitFor(() => expect(queued()?.items[0]?.origin).toBe('subagents'), { timeout: 4000 })
    expect(queued()!.items[0]!.text).toContain('Looks fine.')
    // Its turn ends; the notice runs as a turn of its own.
    t.finish(parentArgs)
    const wakeTurn = await t.promptOn(t.parent.threadId, 1)
    expect(wakeTurn.prompt.text).toContain('<subagents-finished>')
    const started = t.published.filter(
      (event) =>
        event.name === 'turn.started' &&
        (event.scope as { threadId?: string }).threadId === t.parent.threadId,
    )
    expect((started.at(-1)?.payload as { turn: { origin?: string } }).turn.origin).toBe('subagents')
  })

  it('does not wake a parent that waited for the answer, nor for a child it stopped', async () => {
    const t = setup()
    await t.parentTurn()
    const waiting = t.call('spawn_agent', {
      provider: 'opencode',
      prompt: 'Quick check',
      title: 'Quick',
      background: false,
    })
    await vi.waitFor(() => expect(t.records(t.parent.threadId).length).toBeGreaterThan(0))
    const card = t.latest(t.parent.threadId)
    const childThread = (
      t.database
        .prepare('SELECT thread_id FROM threads WHERE session_id = ?')
        .get(card.childSessionId!) as {
        thread_id: string
      }
    ).thread_id
    const child = await t.promptOn(childThread)
    t.promptStarted(child)
    t.emit(
      childThread,
      'opencode',
      {
        category: 'stream',
        event: 'agent_message_chunk',
        data: { content: { type: 'text', text: 'All good.' } },
      },
      `run-${child.userMessageId}`,
    )
    t.finish(child)
    const answer = await waiting
    expect(answer.text).toContain('All good.')

    await t.call('spawn_agent', { provider: 'opencode', prompt: 'Long job', title: 'Long' })
    const second = t.latest(t.parent.threadId)
    const stopped = await t.call('stop_agent', { id: second.subagentId })
    expect(stopped.isError).toBeUndefined()
    await vi.waitFor(() => expect(t.latest(t.parent.threadId).status).toBe('cancelled'))

    await new Promise((resolve) => setTimeout(resolve, 1_800))
    const woke = t.published.some(
      (event) =>
        event.name === 'thread.queue.updated' &&
        (event.scope as { threadId?: string }).threadId === t.parent.threadId &&
        (event.payload as { items: { origin?: string }[] }).items.some(
          (item) => item.origin === 'subagents',
        ),
    )
    expect(woke).toBe(false)
  })
})

describe('spawn_agent, as the review found it', () => {
  const childThreadOf = (t: ReturnType<typeof setup>, card: Subagent) =>
    (
      t.database
        .prepare('SELECT thread_id FROM threads WHERE session_id = ?')
        .get(card.childSessionId!) as { thread_id: string }
    ).thread_id
  const parentQueue = (t: ReturnType<typeof setup>) =>
    t.published
      .filter(
        (event) =>
          event.name === 'thread.queue.updated' &&
          (event.scope as { threadId?: string }).threadId === t.parent.threadId,
      )
      .at(-1)?.payload as { items: { origin?: string }[] } | undefined

  it('gives each of two calls made in one message its own card, in order', async () => {
    const t = setup()
    const args = await t.parentTurn()
    t.emit(
      t.parent.threadId,
      'claude',
      {
        category: 'tool',
        event: 'tool_call',
        data: {
          toolCallId: 'toolu_spawn_2',
          title: 'spawn_agent',
          toolName: 'mcp__openmanager__spawn_agent',
          status: 'in_progress',
        },
      },
      `run-${args.userMessageId}`,
    )
    await t.call('spawn_agent', { provider: 'opencode', prompt: 'First', title: 'First' })
    await t.call('spawn_agent', { provider: 'opencode', prompt: 'Second', title: 'Second' })
    const calls = [
      ...new Set(
        t.published
          .filter((event) => event.name === 'tool.updated')
          .map((event) => (event.payload as { toolCallId: string }).toolCallId),
      ),
    ]
    const byTitle = new Map(t.records(t.parent.threadId).map((record) => [record.title, record]))
    expect([byTitle.get('First')!.toolCallId, byTitle.get('Second')!.toolCallId]).toEqual(calls)
  })

  it('takes back a queued notice once the parent read the answer itself', async () => {
    const t = setup()
    await t.parentTurn()
    await t.call('spawn_agent', { provider: 'opencode', prompt: 'Review', title: 'Review' })
    const card = t.latest(t.parent.threadId)
    const child = await t.promptOn(childThreadOf(t, card))
    t.promptStarted(child)
    t.finish(child)
    await vi.waitFor(() => expect(parentQueue(t)?.items[0]?.origin).toBe('subagents'), {
      timeout: 4000,
    })
    const read = await t.call('wait_agent', { id: card.subagentId })
    expect(read.text).toContain('[completed]')
    expect(parentQueue(t)?.items).toEqual([])
  })

  it('finds its children again after a restart, and a follow-up runs them again', async () => {
    const t = setup()
    const parentArgs = await t.parentTurn()
    await t.call('spawn_agent', { provider: 'opencode', prompt: 'Review', title: 'Review' })
    const card = t.latest(t.parent.threadId)
    const child = await t.promptOn(childThreadOf(t, card))
    t.promptStarted(child)
    t.finish(child)
    await vi.waitFor(() => expect(t.latest(t.parent.threadId).status).toBe('completed'))
    t.call('wait_agent', { id: card.subagentId })
    t.finish(parentArgs)

    t.restart()
    t.dispatch('session.open', { sessionId: t.parent.sessionId })
    const listed = await t.call('list_agents', {})
    expect(listed.text).toContain('- Review [completed')
    expect(listed.text).toContain(`id: ${card.subagentId} (session ${card.childSessionId})`)
    const sent = await t.call('send_agent', { id: card.subagentId, message: 'One more check' })
    expect(sent.isError).toBeUndefined()
    const again = await t.promptOn(childThreadOf(t, card), 1)
    expect(again.prompt.text).toBe('One more check')
    await vi.waitFor(() => expect(t.latest(t.parent.threadId).status).toBe('running'))
  })

  it('queues a follow-up for a busy child as the parent’s, which a person cannot take back', async () => {
    const t = setup()
    await t.parentTurn()
    await t.call('spawn_agent', { provider: 'opencode', prompt: 'Long job', title: 'Long' })
    const card = t.latest(t.parent.threadId)
    const childThread = childThreadOf(t, card)
    t.promptStarted(await t.promptOn(childThread))
    const sent = await t.call('send_agent', { id: card.subagentId, message: 'Also check X' })
    expect(sent.text).toContain('Queued')
    const queued = t.published
      .filter(
        (event) =>
          event.name === 'thread.queue.updated' &&
          (event.scope as { threadId?: string }).threadId === childThread,
      )
      .at(-1)?.payload as { items: { queueItemId: string; origin?: string }[] }
    expect(queued.items[0]!.origin).toBe('delegated')
    const removed = t.dispatch('queue.remove', {
      sessionId: card.childSessionId!,
      threadId: childThread,
      queueItemId: queued.items[0]!.queueItemId,
    }) as { type: string; error?: { message: string } }
    expect(removed.type).toBe('error')
    expect(removed.error?.message).toContain('only it can take it back')
  })
})

describe('the agent listings and other providers, on the thread service', () => {
  const childThreadOf = (t: ReturnType<typeof setup>, card: Subagent) =>
    (
      t.database
        .prepare('SELECT thread_id FROM threads WHERE session_id = ?')
        .get(card.childSessionId!) as { thread_id: string }
    ).thread_id

  it('list_active_agents shows a spawned child under its parent, and a native subagent beside it', async () => {
    const t = setup()
    const args = await t.parentTurn()
    await t.call('spawn_agent', {
      provider: 'opencode',
      prompt: 'Review src/parser.ts and report bugs',
      title: 'Review the parser',
    })
    const card = t.latest(t.parent.threadId)
    const child = await t.promptOn(childThreadOf(t, card))
    t.promptStarted(child)
    t.emit(
      childThreadOf(t, card),
      'opencode',
      {
        category: 'tool',
        event: 'tool_call',
        data: { toolCallId: 'read-1', title: 'Read src/parser.ts', status: 'in_progress' },
      },
      `run-${child.userMessageId}`,
    )
    await vi.waitFor(() => expect(t.latest(t.parent.threadId).stats.toolCalls).toBe(1))
    // Claude's own Agent tool starts a subagent of the parent's.
    t.emit(
      t.parent.threadId,
      'claude',
      {
        category: 'tool',
        event: 'subtask_update',
        data: {
          taskId: 'toolu_agent',
          status: 'running',
          title: 'Find the callers',
          prompt: 'Find every caller of parse()',
          subagentType: 'Explore',
        },
      },
      `run-${args.userMessageId}`,
    )
    const native = t.records(t.parent.threadId).find((item) => item.origin === 'native')!
    expect(native).toBeDefined()

    const active = await t.call('list_active_agents', {})
    expect(active.isError).toBeUndefined()
    // How long each has run depends on the machine; the rest is exact.
    const timeless = (text: string) => text.replace(/running, \d+s/g, 'running, Ns')
    const text = timeless(active.text)
    expect(text).toContain('Agents running now in this environment: 3 live.')
    expect(text).toContain(
      'Project Project:\n' +
        `- Parent [running, Ns] claude · you\n  id: ${t.parent.sessionId}\n  now: spawn_agent\n`,
    )
    expect(text).toContain(
      `  - Review the parser [running, Ns, 1 tool call] opencode · your subagent (yours to act on)\n` +
        `    id: ${card.childSessionId}, subagent ${card.subagentId} started with spawn_agent\n` +
        '    for: Review src/parser.ts and report bugs\n' +
        '    now: Read src/parser.ts',
    )
    expect(text).toContain(
      `  - Find the callers [running, Ns] claude · your subagent\n` +
        `    id: ${native.childSessionId}, Explore subagent ${native.subagentId} of its provider's own\n` +
        '    for: Find every caller of parse()',
    )

    const lineage = await t.call('list_agents', {})
    expect(lineage.text).toContain('(2 live, 0 finished)')
    expect(lineage.text).toContain(
      `id: ${card.subagentId} (session ${card.childSessionId}) · yours: send_agent, wait_agent, stop_agent`,
    )
    expect(lineage.text).toContain(
      `id: ${native.subagentId} (session ${native.childSessionId}) · reach it with your own subagent tool`,
    )

    // The child sees its parent and its sibling, and itself.
    const fromChild = await createSpawnAgentTools(t.service.spawnHost)
      .find((tool) => tool.name === 'list_active_agents')!
      .call({ scope: 'project' }, { threadId: childThreadOf(t, card), providerId: 'opencode' })
    expect(timeless(fromChild.text)).toContain('- Parent [running, Ns] claude · your parent')
    expect(timeless(fromChild.text)).toContain('- Review the parser [running, Ns, 1 tool call] opencode · you')
    expect(timeless(fromChild.text)).toContain('- Find the callers [running, Ns] claude · sibling')
  })

  it('says nothing else is running when the caller is alone', async () => {
    const t = setup()
    await t.parentTurn()
    const active = await t.call('list_active_agents', {})
    expect(active.text).toContain('Nothing else is running in this environment right now')
  })

  it('spawns, messages, waits on and stops a child on Codex, by either id', async () => {
    const t = setup()
    await t.parentTurn()
    const started = await t.call('spawn_agent', {
      provider: 'codex',
      model: 'gpt-5.5',
      prompt: 'Summarise the README',
      title: 'Summarise README',
    })
    expect(started.isError).toBeUndefined()
    const card = t.latest(t.parent.threadId)
    expect(card).toMatchObject({ providerId: 'codex', modelId: 'gpt-5.5', origin: 'openmanager' })
    const childThread = childThreadOf(t, card)
    const first = await t.promptOn(childThread)
    expect(first.providerId).toBe('codex')
    expect(first.prompt.text).toBe('Summarise the README')
    t.promptStarted(first)
    t.emit(
      childThread,
      'codex',
      {
        category: 'stream',
        event: 'agent_message_chunk',
        data: { content: { type: 'text', text: 'It is a monorepo.' } },
      },
      `run-${first.userMessageId}`,
    )
    t.finish(first)
    // Waited on by its session id, as the listings show it.
    const waited = await t.call('wait_agent', { id: card.childSessionId })
    expect(waited.text).toContain('[completed]')
    expect(waited.text).toContain('It is a monorepo.')

    // A follow-up reaches the Codex child as a new delegated turn of its own.
    const sent = await t.call('send_agent', { id: card.subagentId, message: 'Now list the apps' })
    expect(sent.isError).toBeUndefined()
    expect(sent.text).toContain('Sent to')
    const second = await t.promptOn(childThread, 1)
    expect(second.providerId).toBe('codex')
    expect(second.prompt.text).toBe('Now list the apps')
    t.promptStarted(second)
    await vi.waitFor(() => expect(t.latest(t.parent.threadId).status).toBe('running'))

    // Stopped by its session id: the Codex turn is cancelled and the card says so.
    const stopped = await t.call('stop_agent', { id: card.childSessionId })
    expect(stopped.isError).toBeUndefined()
    expect(t.runtime.cancel).toHaveBeenCalledWith(expect.objectContaining({ providerId: 'codex' }))
    await vi.waitFor(() => expect(t.latest(t.parent.threadId).status).toBe('cancelled'))
  })
})
