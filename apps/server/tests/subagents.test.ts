import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import type { AgentRuntime } from '@agentpack/runtime/node'
import {
  ProofResponseSchemas,
  ScopeSnapshotSchema,
  type CommandEnvelope,
  type Environment,
  type ProofEvent,
  type Subagent,
} from '@openmanager/protocol/node'
import { runMigrations } from '../src/db/migrate.js'
import { MIGRATIONS } from '../src/db/migrations.js'
import { reconcileAfterRestart } from '../src/db/boot-reconcile.js'
import { createReplayReader } from '../src/db/replay.js'
import { createPersistentEventService } from '../src/event-service.js'
import { createThreadService, type WorkspaceRuntimeResolver } from '../src/thread-service.js'

/**
 * Subagents on the environment server (docs/decisions/subagents.md): one
 * record per subagent on the thread that holds the call that started it,
 * and one child session holding its work, fed by the parent's runtime.
 */

const WORKSPACE = '/workspace/project'
const ENVIRONMENT = 'environment-1'
const resolver: WorkspaceRuntimeResolver = (workspaceId) =>
  workspaceId === WORKSPACE
    ? { providerId: 'claude', providers: ['claude'], cwd: WORKSPACE }
    : undefined

function setup() {
  const database = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true })
  runMigrations(database, MIGRATIONS)
  database.exec(
    `INSERT INTO workspaces (workspace_id, name, path, created_at, updated_at)
     VALUES ('${WORKSPACE}', 'Project', '${WORKSPACE}', 1, 1)`,
  )
  const published: ProofEvent[] = []
  const events = createPersistentEventService(database, (record) => published.push(record.event))
  const runtime = {
    ensureSession: vi.fn().mockResolvedValue({ sessionId: 'provider-parent', state: 'created' }),
    // The parent's turn runs until the test lets it end.
    prompt: vi.fn(() => new Promise<void>(() => undefined)),
    cancel: vi.fn().mockResolvedValue(undefined),
    respondPermission: vi.fn(),
    stopSubtask: vi.fn().mockResolvedValue(undefined),
  }
  /** A new service on the same rows is a new process, booted as the host boots. */
  const fresh = () => {
    events.flush()
    reconcileAfterRestart(database, events.repository, ENVIRONMENT)
    const service = createThreadService(
      runtime as unknown as Pick<
        AgentRuntime,
        'ensureSession' | 'prompt' | 'cancel' | 'respondPermission' | 'stopSubtask'
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
      },
    )
    service.setEnvironmentId(ENVIRONMENT)
    return service
  }
  let service = fresh()
  const dispatch = (name: string, payload: CommandEnvelope['payload'], on = service) =>
    on.dispatch({ type: 'command', requestId: name.replaceAll('.', '-'), name, payload })
  const created = ProofResponseSchemas['session.create'].parse(
    dispatch('session.create', {
      environmentId: ENVIRONMENT,
      workspaceId: WORKSPACE,
      providerId: 'claude',
      title: 'Parent',
    }),
  ).payload
  const parent = created.thread

  let seq = 0
  /** One runtime event on the parent's thread, as the Claude runtime sends it. */
  const emit = (event: Record<string, unknown>) =>
    service.onRuntimeEvent({
      id: `runtime-${(seq += 1)}`,
      seq,
      timestamp: new Date().toISOString(),
      providerId: 'claude',
      threadId: parent.threadId,
      workspaceId: WORKSPACE,
      sessionId: 'provider-parent',
      messageId: 'assistant-1',
      ...event,
    } as Parameters<typeof service.onRuntimeEvent>[0])

  /** Send the parent a prompt and let its provider start it. */
  const startParentTurn = async (text = 'Delegate') => {
    const sent = ProofResponseSchemas['turn.send'].parse(
      dispatch('turn.send', { ...parent, text }),
    ).payload
    await vi.waitFor(() => expect(runtime.prompt).toHaveBeenCalled())
    emit({
      category: 'lifecycle',
      event: 'prompt_started',
      data: { prompt: text, userMessageId: sent.userMessage.messageId },
    })
    return sent
  }
  const subtask = (data: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    emit({ category: 'session', event: 'subtask_update', data, ...extra })
  const text = (subtaskId: string | undefined, value: string) =>
    emit({
      category: 'stream',
      event: 'agent_message_chunk',
      data: { content: { type: 'text', text: value } },
      ...(subtaskId ? { subtaskId } : {}),
    })

  const sessionRow = (sessionId: string) =>
    database
      .prepare(
        `SELECT session_id, parent_session_id, provider_session_id, provider_id, status, title,
                subagent_id, subagent_origin, subagent_promptable
         FROM sessions WHERE session_id = ?`,
      )
      .get(sessionId) as Record<string, unknown> | undefined
  const childOf = (sessionId: string) =>
    database
      .prepare('SELECT session_id FROM sessions WHERE parent_session_id = ?')
      .all(sessionId)
      .map((row) => (row as { session_id: string }).session_id)
  const threadOf = (sessionId: string) => {
    events.flush()
    const row = database
      .prepare('SELECT thread_id FROM threads WHERE session_id = ?')
      .get(sessionId) as { thread_id: string }
    return { sessionId, threadId: row.thread_id }
  }
  const stateOf = (target: { sessionId: string; threadId: string }) => service.threadState(target)!
  const records = (target: { threadId: string }): Subagent[] =>
    published
      .filter((event) => event.name === 'subagent.updated' && threadIdOf(event) === target.threadId)
      .map((event) => (event.payload as { subagent: Subagent }).subagent)
  const summary = (sessionId: string) =>
    service.summaries().find((item) => item.sessionId === sessionId)

  return {
    database,
    published,
    events,
    runtime,
    created,
    parent,
    get service() {
      return service
    },
    restart: () => {
      service = fresh()
      return service
    },
    dispatch,
    emit,
    startParentTurn,
    subtask,
    text,
    sessionRow,
    childOf,
    threadOf,
    stateOf,
    records,
    summary,
    close: () => {
      events.close()
      database.close()
    },
  }
}

type Harness = ReturnType<typeof setup>

/** Start a parent turn and report one Claude `Agent` subagent; answers its child's session id. */
async function delegate(h: Harness, data: Record<string, unknown> = {}) {
  await h.startParentTurn()
  h.subtask({
    taskId: 'toolu_agent_1',
    status: 'running',
    description: 'Find the session store',
    prompt: 'Find where sessions are stored and say how they are keyed.',
    subagentType: 'Explore',
    stoppable: true,
    ...data,
  })
  h.events.flush()
  const [child] = h.childOf(h.created.session.sessionId)
  return child!
}

describe('subagents', () => {
  it('files a child session with a delegated turn the moment a subagent is first reported', async () => {
    const h = setup()
    try {
      const childId = await delegate(h)
      const record = h.records(h.parent).at(-1)!
      expect(record).toMatchObject({
        parentSessionId: h.created.session.sessionId,
        depth: 1,
        origin: 'native',
        providerId: 'claude',
        agentType: 'Explore',
        title: 'Find the session store',
        prompt: 'Find where sessions are stored and say how they are keyed.',
        status: 'running',
        background: false,
        childSessionId: childId,
        promptable: false,
        stoppable: true,
      })
      expect(record.turnId).toBe(h.stateOf(h.parent).turns.at(-1)!.turnId)
      expect(record.toolCallId).toEqual(expect.any(String))
      expect(h.sessionRow(childId)).toMatchObject({
        parent_session_id: h.created.session.sessionId,
        provider_session_id: null,
        provider_id: 'claude',
        status: 'running',
        title: 'Find the session store',
        subagent_id: record.subagentId,
        subagent_origin: 'native',
        subagent_promptable: 0,
      })
      // The child announces what it holds, as any client reads its summary.
      expect(
        h.published.find(
          (event) =>
            event.name === 'session.created' &&
            (event.payload as { session: { sessionId: string } }).session.sessionId === childId,
        )?.payload,
      ).toMatchObject({
        session: {
          parentSessionId: h.created.session.sessionId,
          subagent: { subagentId: record.subagentId, origin: 'native', promptable: false },
        },
      })
      expect(h.summary(childId)).toMatchObject({
        status: 'running',
        subagent: { subagentId: record.subagentId, origin: 'native', promptable: false },
      })
      // Its own turn, begun by the parent agent, opens with what it was asked.
      const child = h.stateOf(h.threadOf(childId))
      expect(child.turns).toMatchObject([{ state: 'running', origin: 'delegated' }])
      expect(child.messages).toMatchObject([
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Find where sessions are stored and say how they are keyed.' },
          ],
        },
      ])
      // Reported again, it stays one subagent with one child.
      h.subtask({ taskId: 'toolu_agent_1', toolCallCount: 3, currentActivity: 'Grep\nsessions' })
      h.events.flush()
      expect(h.childOf(h.created.session.sessionId)).toEqual([childId])
      expect(h.records(h.parent).at(-1)).toMatchObject({
        subagentId: record.subagentId,
        stats: { toolCalls: 3 },
        activity: 'Grep',
      })
      // Only the agent that started it can reach it.
      expect(h.dispatch('turn.send', { ...h.threadOf(childId), text: 'Hello' })).toMatchObject({
        type: 'error',
        error: { code: 'capability_missing' },
      })
    } finally {
      h.close()
    }
  })

  it("files a subagent's work in its child and never in the parent's transcript", async () => {
    const h = setup()
    try {
      const childId = await delegate(h)
      const child = h.threadOf(childId)
      h.text(undefined, 'Delegating now.')
      h.text('toolu_agent_1', 'Looking in src/db.')
      h.emit({
        category: 'tool',
        event: 'tool_call',
        subtaskId: 'toolu_agent_1',
        data: {
          toolCallId: 'toolu_grep',
          title: 'Grep sessions',
          kind: 'search',
          status: 'in_progress',
        },
      })
      h.emit({
        category: 'tool',
        event: 'tool_call_update',
        subtaskId: 'toolu_agent_1',
        data: { toolCallId: 'toolu_grep', status: 'completed' },
      })
      h.text('toolu_agent_1', 'Sessions are keyed by id.')
      h.subtask({
        taskId: 'toolu_agent_1',
        status: 'completed',
        resultText: 'Sessions are keyed by id.',
        durationMs: 1234.4,
      })
      h.events.flush()

      const childState = h.stateOf(child)
      expect(childState.turns).toMatchObject([{ state: 'completed', origin: 'delegated' }])
      expect(
        childState.messages
          .filter((message) => message.role === 'assistant')
          .map((message) => message.content),
      ).toEqual([
        [{ type: 'text', text: 'Looking in src/db.' }],
        [{ type: 'text', text: 'Sessions are keyed by id.' }],
      ])
      expect(childState.tools).toMatchObject([{ title: 'Grep sessions', status: 'completed' }])

      const parentState = h.stateOf(h.parent)
      expect(parentState.tools).toEqual([])
      expect(
        parentState.messages.flatMap((message) =>
          message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])),
        ),
      ).toEqual(['Delegate', 'Delegating now.'])
      // No event of the subagent went to the parent's thread except its card.
      expect(
        h.published
          .filter(
            (event) =>
              threadIdOf(event) === h.parent.threadId &&
              (event.name === 'message.delta' || event.name === 'tool.updated'),
          )
          .map((event) => event.payload),
      ).toMatchObject([{ role: 'assistant', content: { text: 'Delegating now.' } }])

      expect(h.records(h.parent).at(-1)).toMatchObject({
        status: 'completed',
        result: 'Sessions are keyed by id.',
        stats: { durationMs: 1234 },
        finishedAt: expect.any(String),
      })
      // Settled, its child rests; the parent still runs its own turn.
      expect(h.summary(childId)).toMatchObject({ status: 'idle' })
      expect(h.summary(h.created.session.sessionId)).toMatchObject({ status: 'running' })
      // Work that trails its end has no turn to go to.
      h.text('toolu_agent_1', 'Late.')
      h.events.flush()
      expect(h.stateOf(child).messages).toHaveLength(3)
    } finally {
      h.close()
    }
  })

  it('keeps streaming a background subagent into its child after the parent turn ends', async () => {
    const h = setup()
    let finish = () => undefined as void
    h.runtime.prompt.mockImplementationOnce(
      () => new Promise<void>((resolve) => (finish = resolve)),
    )
    try {
      const childId = await delegate(h, { background: true })
      emitCompleted(h)
      finish()
      await vi.waitFor(() =>
        expect(h.summary(h.created.session.sessionId)).toMatchObject({ status: 'idle' }),
      )
      expect(h.stateOf(h.parent).turns.at(-1)).toMatchObject({ state: 'completed' })

      h.text('toolu_agent_1', 'Still working after the parent finished.')
      h.subtask({ taskId: 'toolu_agent_1', status: 'completed', resultText: 'Done.' })
      h.events.flush()
      const child = h.stateOf(h.threadOf(childId))
      expect(child.turns).toMatchObject([{ state: 'completed', origin: 'delegated' }])
      expect(child.messages.at(-1)).toMatchObject({
        role: 'assistant',
        content: [{ type: 'text', text: 'Still working after the parent finished.' }],
      })
      expect(h.records(h.parent).at(-1)).toMatchObject({ status: 'completed', background: true })
    } finally {
      h.close()
    }
  })

  it("files a nested subagent under its parent subagent's child, with its card there", async () => {
    const h = setup()
    try {
      const outerChild = await delegate(h)
      const outer = h.records(h.parent).at(-1)!
      h.subtask(
        {
          taskId: 'toolu_agent_2',
          parentTaskId: 'toolu_agent_1',
          status: 'running',
          description: 'Read the migrations',
          prompt: 'Read every migration.',
        },
        // The spawning call is the outer subagent's own work.
        { subtaskId: 'toolu_agent_1' },
      )
      h.events.flush()
      const [innerChild] = h.childOf(outerChild)
      expect(innerChild).toEqual(expect.any(String))
      const outerThread = h.threadOf(outerChild)
      const inner = h.records(outerThread).at(-1)!
      expect(inner).toMatchObject({
        parentSessionId: outerChild,
        parentSubagentId: outer.subagentId,
        depth: 2,
        childSessionId: innerChild,
        title: 'Read the migrations',
      })
      expect(inner.turnId).toBe(h.stateOf(outerThread).turns[0]!.turnId)
      // The parent's card list holds its direct subagents only.
      expect(h.records(h.parent).map((record) => record.subagentId)).not.toContain(inner.subagentId)
      expect(h.stateOf(outerThread).subagents.map((record) => record.subagentId)).toEqual([
        inner.subagentId,
      ])
      h.text('toolu_agent_2', 'Inner work.')
      h.events.flush()
      expect(h.stateOf(h.threadOf(innerChild!)).messages.at(-1)).toMatchObject({
        content: [{ type: 'text', text: 'Inner work.' }],
      })
      expect(h.stateOf(outerThread).messages).toHaveLength(1)

      // Deleting the parent takes every child with it, deepest first.
      h.published.length = 0
      expect(
        h.dispatch('session.delete', { sessionId: h.created.session.sessionId }),
      ).toMatchObject({ type: 'response' })
      expect(
        h.published
          .filter((event) => event.name === 'session.deleted')
          .map((event) => (event.payload as { sessionId: string }).sessionId),
      ).toEqual([innerChild, outerChild, h.created.session.sessionId])
      expect(h.database.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 0 })
      expect(h.database.prepare('SELECT COUNT(*) AS n FROM subagents').get()).toEqual({ n: 0 })
      // A report after the deletion files nothing.
      h.subtask({ taskId: 'toolu_agent_1', status: 'completed' })
      h.events.flush()
      expect(h.database.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 0 })
    } finally {
      h.close()
    }
  })

  it('places a native subagent where its claimed call happened, in the snapshot order', async () => {
    const h = setup()
    try {
      const tool = (toolCallId: string) =>
        h.emit({
          category: 'tool',
          event: 'tool_call',
          data: { toolCallId, title: 'Read', toolName: 'Read', status: 'completed' },
        })
      await h.startParentTurn()
      tool('toolu_read_1')
      // The runtime claimed the Agent call: only its subtask_update arrives.
      h.subtask({ taskId: 'toolu_agent_1', status: 'running', description: 'Find it' })
      tool('toolu_read_2')
      h.events.flush()

      const state = h.stateOf(h.parent)
      const [record] = state.subagents ?? []
      expect(record?.toolCallId).toBeDefined()
      expect(state.tools.some((item) => item.toolCallId === record!.toolCallId)).toBe(false)
      const toolRefs = state.order.filter((ref) => ref.kind === 'tool').map((ref) => ref.id)
      const [read1, read2] = state.tools.map((item) => item.toolCallId)
      expect(toolRefs).toEqual([read1, record!.toolCallId, read2])
    } finally {
      h.close()
    }
  })

  it('carries the records in the thread snapshot, and settles a running one after a restart', async () => {
    const h = setup()
    try {
      const childId = await delegate(h)
      const reader = createReplayReader(h.database, {
        epoch: 'epoch-test',
        environment: () => ({}) as Environment,
        workspaces: () => [],
      })
      const scope = { type: 'thread' as const, environmentId: ENVIRONMENT, ...h.parent }
      const snapshot = (() => {
        h.events.flush()
        const result = reader.read(scope, null)
        if (result.mode !== 'snapshot') throw new Error(result.mode)
        return ScopeSnapshotSchema.parse(result.snapshot)
      })()
      expect('subagents' in snapshot.state && snapshot.state.subagents).toMatchObject([
        { status: 'running', childSessionId: childId, title: 'Find the session store' },
      ])

      // The provider process is gone with the old host.
      h.restart()
      expect(h.stateOf(h.parent).subagents).toMatchObject([
        {
          status: 'interrupted',
          statusReason: expect.any(String),
          finishedAt: expect.any(String),
        },
      ])
      expect(h.stateOf(h.threadOf(childId)).turns).toMatchObject([
        { state: 'interrupted', origin: 'delegated', interruptedBy: 'server_restarted' },
      ])
      // The child still opens, from the rows alone.
      expect(h.dispatch('session.open', { sessionId: childId })).toMatchObject({
        type: 'response',
        payload: { session: { sessionId: childId, subagent: { origin: 'native' } } },
      })
      expect(h.runtime.ensureSession).not.toHaveBeenCalledWith(
        expect.objectContaining({ threadId: h.threadOf(childId).threadId }),
      )

      // Revived under the same key after the restart, it reopens the same child.
      expect(h.dispatch('session.open', { sessionId: h.created.session.sessionId })).toMatchObject({
        type: 'response',
      })
      await h.startParentTurn('Ask it again')
      h.subtask({ taskId: 'toolu_agent_1', status: 'running', prompt: 'And the threads?' })
      h.events.flush()
      expect(h.childOf(h.created.session.sessionId)).toEqual([childId])
      const turns = h.stateOf(h.threadOf(childId)).turns
      expect(turns).toHaveLength(2)
      expect(turns[1]).toMatchObject({ state: 'running', origin: 'delegated' })
      expect(h.stateOf(h.threadOf(childId)).messages.at(-1)).toMatchObject({
        role: 'user',
        content: [{ type: 'text', text: 'And the threads?' }],
      })
      expect(h.stateOf(h.parent).subagents).toMatchObject([{ status: 'running' }])
    } finally {
      h.close()
    }
  })

  it('files a subagent permission on its child, waits the parent too, and answers from the child', async () => {
    const h = setup()
    try {
      const childId = await delegate(h)
      const child = h.threadOf(childId)
      h.emit({
        category: 'permission',
        event: 'permission_request',
        subtaskId: 'toolu_agent_1',
        data: {
          requestId: 'provider-permission',
          sessionId: 'provider-parent',
          toolCall: { toolCallId: 'toolu_bash', title: 'Run tests' },
          options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
        },
      })
      h.events.flush()
      const [request] = h.stateOf(child).interactions
      expect(request).toBeDefined()
      expect(h.stateOf(h.parent).interactions).toEqual([])
      expect(h.summary(childId)).toMatchObject({ status: 'waiting', waitingOn: 'permission' })
      // The parent's provider is blocked on it.
      expect(h.summary(h.created.session.sessionId)).toMatchObject({
        status: 'waiting',
        waitingOn: 'permission',
      })
      expect(
        h.published.some(
          (event) =>
            event.name === 'session.updated' &&
            (event.payload as { sessionId: string; status?: string }).sessionId ===
              h.created.session.sessionId &&
            (event.payload as { status?: string }).status === 'waiting',
        ),
      ).toBe(true)
      expect(h.records(h.parent).at(-1)).toMatchObject({
        status: 'waiting',
        waitingOn: 'permission',
      })

      expect(
        h.dispatch('interaction.respond', {
          ...child,
          response: {
            kind: 'permission',
            interactionId: request!.interaction.interactionId,
            outcome: { outcome: 'selected', optionId: 'allow' },
          },
        }),
      ).toMatchObject({ type: 'response' })
      expect(h.runtime.respondPermission).toHaveBeenCalledExactlyOnceWith({
        providerId: 'claude',
        requestId: 'provider-permission',
        outcome: { outcome: 'selected', optionId: 'allow' },
      })
      // The runtime's settlement finds the child even untagged.
      h.emit({
        category: 'permission',
        event: 'permission_resolved',
        data: {
          requestId: 'provider-permission',
          outcome: { outcome: 'selected', optionId: 'allow' },
        },
      })
      h.events.flush()
      expect(h.stateOf(child).interactions).toEqual([])
      expect(h.summary(childId)).toMatchObject({ status: 'running' })
      expect(h.summary(h.created.session.sessionId)).toMatchObject({ status: 'running' })
      expect(h.summary(h.created.session.sessionId)?.waitingOn).toBeUndefined()
      expect(h.records(h.parent).at(-1)).toMatchObject({ status: 'running' })
      expect(h.records(h.parent).at(-1)?.waitingOn).toBeUndefined()
    } finally {
      h.close()
    }
  })

  it('stops a subagent through its runtime, refuses one that cannot be stopped, and ignores a settled one', async () => {
    const h = setup()
    try {
      await delegate(h)
      const { subagentId } = h.records(h.parent).at(-1)!
      const stop = (id = subagentId, sessionId = h.created.session.sessionId) =>
        h.dispatch('subagent.stop', { sessionId, subagentId: id })
      await expect(Promise.resolve(stop())).resolves.toMatchObject({
        type: 'response',
        payload: null,
      })
      expect(h.runtime.stopSubtask).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          providerId: 'claude',
          threadId: h.parent.threadId,
          taskId: 'toolu_agent_1',
        }),
      )
      expect(stop('unknown')).toMatchObject({ type: 'error', error: { code: 'not_found' } })
      expect(stop(subagentId, 'another-session')).toMatchObject({
        type: 'error',
        error: { code: 'not_found' },
      })
      // The runtime reports the stop itself.
      h.subtask({ taskId: 'toolu_agent_1', status: 'cancelled', statusReason: 'Stopped' })
      h.events.flush()
      expect(h.records(h.parent).at(-1)).toMatchObject({ status: 'cancelled' })
      h.runtime.stopSubtask.mockClear()
      expect(stop()).toMatchObject({ type: 'response', payload: null })
      expect(h.runtime.stopSubtask).not.toHaveBeenCalled()

      h.subtask({ taskId: 'toolu_agent_3', status: 'running', description: 'Unstoppable' })
      h.events.flush()
      const unstoppable = h.records(h.parent).at(-1)!
      expect(unstoppable).toMatchObject({ title: 'Unstoppable', stoppable: false })
      expect(stop(unstoppable.subagentId)).toMatchObject({
        type: 'error',
        error: { code: 'capability_missing' },
      })
    } finally {
      h.close()
    }
  })

  it('ends a foreground subagent with the parent turn that ran it', async () => {
    const h = setup()
    try {
      const childId = await delegate(h)
      const turnId = h.stateOf(h.parent).turns.at(-1)!.turnId
      expect(h.dispatch('turn.interrupt', { ...h.parent, turnId })).toMatchObject({
        type: 'response',
      })
      h.emit({
        category: 'lifecycle',
        event: 'prompt_completed',
        data: { stopReason: 'cancelled' },
      })
      await vi.waitFor(() =>
        expect(h.records(h.parent).at(-1)).toMatchObject({ status: 'interrupted' }),
      )
      h.events.flush()
      expect(h.stateOf(h.threadOf(childId)).turns).toMatchObject([{ state: 'interrupted' }])
      expect(h.summary(childId)).toMatchObject({ status: 'idle' })
    } finally {
      h.close()
    }
  })
})

const threadIdOf = (event: ProofEvent) =>
  event.scope.type === 'thread' ? event.scope.threadId : undefined

/** End the parent's running turn as its provider would. */
function emitCompleted(h: Harness) {
  h.emit({ category: 'lifecycle', event: 'prompt_completed', data: { stopReason: 'end_turn' } })
}
