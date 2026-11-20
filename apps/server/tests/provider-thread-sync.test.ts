import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentRuntime } from '@agentpack/runtime/node'
import { ProofResponseSchemas, type CommandEnvelope } from '@openmanager/protocol/node'
import { runMigrations } from '../src/db/migrate.js'
import { MIGRATIONS } from '../src/db/migrations.js'
import { createPersistentEventService } from '../src/event-service.js'
import type { TitleGenerator } from '../src/session-titles/generator.js'
import { createThreadService, type WorkspaceRuntimeResolver } from '../src/thread-service.js'

/**
 * What a session's provider is told of its title and its deletion
 * (docs/decisions/codex-app-server.md, "Threads: archive on delete, no
 * import"): titles the user or the title model wrote go to its live runtime
 * and ride every start, and deleting the session retires its provider session.
 */

const WORKSPACE = '/workspace/project'
const registered: WorkspaceRuntimeResolver = (workspaceId) =>
  workspaceId === WORKSPACE ? { providerId: 'codex', cwd: WORKSPACE } : undefined

const closers: (() => void)[] = []
afterEach(() => {
  for (const close of closers.splice(0)) close()
})

function runtimeDouble() {
  return {
    ensureSession: vi.fn().mockResolvedValue({ sessionId: 'codex-thread', state: 'created' }),
    prompt: vi.fn().mockResolvedValue({ sessionId: 'codex-thread', state: 'reused' }),
    cancel: vi.fn().mockResolvedValue(undefined),
    setSessionTitle: vi.fn().mockResolvedValue(undefined),
    retireSession: vi.fn().mockResolvedValue(undefined),
  }
}

function serviceOn(
  database: DatabaseSync,
  events: ReturnType<typeof createPersistentEventService>,
  runtime: ReturnType<typeof runtimeDouble>,
  titles?: TitleGenerator,
) {
  const service = createThreadService(
    runtime as unknown as Pick<AgentRuntime, 'ensureSession' | 'prompt' | 'cancel'>,
    { rejection: () => undefined },
    (event) => events.append(event),
    undefined,
    registered,
    {
      database,
      flush: events.flush,
      appendAtomic: (batch, options) => events.appendAtomic(batch, options),
      ...(titles ? { titles } : {}),
    },
  )
  service.setEnvironmentId('environment-1')
  const dispatch = (name: string, payload: CommandEnvelope['payload']) =>
    service.dispatch({ type: 'command', requestId: name.replaceAll('.', '-'), name, payload })
  return { service, dispatch }
}

async function setup(titles?: TitleGenerator) {
  const database = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true })
  runMigrations(database, MIGRATIONS)
  database.exec(
    `INSERT INTO workspaces (workspace_id, name, path, created_at, updated_at) VALUES ('${WORKSPACE}', 'Project', '${WORKSPACE}', 1, 1)`,
  )
  const events = createPersistentEventService(database, () => undefined, {})
  closers.push(() => {
    events.close()
    database.close()
  })
  const runtime = runtimeDouble()
  const { service, dispatch } = serviceOn(database, events, runtime, titles)
  const created = ProofResponseSchemas['session.create'].parse(
    dispatch('session.create', {
      environmentId: 'environment-1',
      workspaceId: WORKSPACE,
      providerId: 'codex',
    }),
  ).payload
  const { sessionId } = created.session
  await service.resolveRuntimeSession(sessionId)
  const send = async (text: string) => {
    runtime.prompt.mockClear()
    dispatch('turn.send', { ...created.thread, text })
    await vi.waitFor(() => expect(runtime.prompt).toHaveBeenCalled())
    return runtime.prompt.mock.calls[0]![0] as { title?: string }
  }
  return { database, events, runtime, dispatch, created, sessionId, send }
}

describe('provider session titles', () => {
  it('gives a renamed session’s live runtime the new title, and every later start', async () => {
    const h = await setup()
    // A title made from the first prompt is not given to the provider.
    expect(await h.send('fix the reconnect loop')).not.toHaveProperty('title')

    expect(h.dispatch('session.rename', { sessionId: h.sessionId, title: 'Mine' })).toMatchObject({
      type: 'response',
    })
    expect(h.runtime.setSessionTitle).toHaveBeenCalledWith({
      providerId: 'codex',
      threadId: h.created.thread.threadId,
      title: 'Mine',
    })
    expect(await h.send('and add a test')).toMatchObject({ title: 'Mine' })
  })

  it('gives the provider a generated title', async () => {
    const titles: TitleGenerator = {
      generate: async () => ({ title: 'Fix Reconnect Loop', needsRefinement: false }),
    }
    const h = await setup(titles)
    await h.send('fix the reconnect loop')
    await vi.waitFor(() =>
      expect(h.runtime.setSessionTitle).toHaveBeenCalledWith({
        providerId: 'codex',
        threadId: h.created.thread.threadId,
        title: 'Fix Reconnect Loop',
      }),
    )
  })
})

describe('provider sessions of deleted sessions', () => {
  it('retires the provider session of a deleted session', async () => {
    const h = await setup()
    await h.send('fix the reconnect loop')
    expect(h.dispatch('session.delete', { sessionId: h.sessionId })).toMatchObject({
      type: 'response',
    })
    await vi.waitFor(() =>
      expect(h.runtime.retireSession).toHaveBeenCalledWith({
        providerId: 'codex',
        threadId: h.created.thread.threadId,
        workspaceId: WORKSPACE,
        cwd: WORKSPACE,
        sessionId: 'codex-thread',
      }),
    )
  })

  it('retires one only SQLite still holds, as after a restart', async () => {
    const h = await setup()
    await h.send('fix the reconnect loop')
    const runtime = runtimeDouble()
    const restarted = serviceOn(h.database, h.events, runtime)
    expect(restarted.dispatch('session.delete', { sessionId: h.sessionId })).toMatchObject({
      type: 'response',
    })
    await vi.waitFor(() =>
      expect(runtime.retireSession).toHaveBeenCalledWith({
        providerId: 'codex',
        threadId: h.created.thread.threadId,
        workspaceId: WORKSPACE,
        cwd: WORKSPACE,
        sessionId: 'codex-thread',
      }),
    )
  })

  it('leaves a renamed session’s provider session alone', async () => {
    const h = await setup()
    await h.send('fix the reconnect loop')
    h.dispatch('session.rename', { sessionId: h.sessionId, title: 'Mine' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(h.runtime.retireSession).not.toHaveBeenCalled()
  })
})
