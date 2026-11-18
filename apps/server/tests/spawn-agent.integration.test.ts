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
    ? { providerId: 'claude', providers: ['claude', 'opencode'], cwd: WORKSPACE }
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
  const service = createThreadService(
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
      ],
    },
  )
  service.setEnvironmentId(ENVIRONMENT)
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

  const tools = createSpawnAgentTools(service.spawnHost)
  const call = (name: string, input: Record<string, unknown>) =>
    tools
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
    service,
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
