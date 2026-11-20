import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentRuntime } from '@agentpack/runtime/node'
import { ProofResponseSchemas } from '@openmanager/protocol/node'
import { createThreadService, type WorkspaceRuntimeResolver } from '../src/thread-service.js'
import { createPersistentEventService } from '../src/event-service.js'
import { openEnvironmentDatabase } from '../src/db/database.js'
import { readSessionHistory } from '../src/session-titles/transcript.js'

const registered: WorkspaceRuntimeResolver = (workspaceId) =>
  workspaceId === '/workspace/project'
    ? { providerId: 'codex', cwd: '/workspace/project' }
    : undefined

const directories: string[] = []
const databases: DatabaseSync[] = []

afterEach(async () => {
  for (const database of databases.splice(0)) database.close()
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

describe('readSessionHistory', () => {
  // What a Codex thread deleted outside openmanager is replaced with: the
  // conversation as stored, each message under the id its prompt was sent
  // with, so the runtime can leave out the prompt about to run.
  it('reads a thread’s conversation, oldest first, under the ids prompts carry', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'openmanager-history-test-'))
    directories.push(directory)
    const database = openEnvironmentDatabase(directory)
    databases.push(database)
    database.exec(`
      INSERT INTO workspaces (workspace_id, name, path, created_at, updated_at)
      VALUES ('/workspace/project', 'Project', '/workspace/project', 1, 1);
    `)
    const events = createPersistentEventService(database, () => undefined, {})
    const runtime = {
      ensureSession: vi.fn().mockResolvedValue({ sessionId: 'provider-session', state: 'created' }),
      prompt: vi.fn(() => new Promise<void>(() => undefined)),
      cancel: vi.fn(),
    }
    const service = createThreadService(
      runtime as unknown as Pick<AgentRuntime, 'ensureSession' | 'prompt' | 'cancel'>,
      { rejection: () => undefined },
      events.append,
      events.publishTransient,
      registered,
      { database, flush: events.flush, appendAtomic: events.appendAtomic },
    )
    service.setEnvironmentId('environment-1')
    const created = ProofResponseSchemas['session.create'].parse(
      service.dispatch({
        type: 'command',
        requestId: 'create',
        name: 'session.create',
        payload: {
          environmentId: 'environment-1',
          workspaceId: '/workspace/project',
          providerId: 'codex',
        },
      }),
    ).payload
    const target = { sessionId: created.session.sessionId, threadId: created.thread.threadId }
    const sent = ProofResponseSchemas['turn.send'].parse(
      service.dispatch({
        type: 'command',
        requestId: 'send',
        name: 'turn.send',
        payload: { ...target, text: 'Remember the number 7' },
      }),
    ).payload
    await vi.waitFor(() => expect(runtime.prompt).toHaveBeenCalledTimes(1))
    expect(runtime.prompt).toHaveBeenCalledWith(
      expect.objectContaining({ userMessageId: sent.userMessage.messageId }),
    )
    let seq = 0
    const emit = (event: Record<string, unknown>) =>
      service.onRuntimeEvent({
        id: `runtime-${++seq}`,
        seq,
        timestamp: '2026-11-20T10:00:00.000Z',
        providerId: 'codex',
        threadId: target.threadId,
        workspaceId: '/workspace/project',
        sessionId: 'provider-session',
        messageId: 'assistant-1',
        ...event,
      } as Parameters<typeof service.onRuntimeEvent>[0])
    emit({
      category: 'lifecycle',
      event: 'prompt_started',
      data: { prompt: 'Remember the number 7', userMessageId: sent.userMessage.messageId },
    })
    emit({
      category: 'stream',
      event: 'agent_message_chunk',
      data: { content: { type: 'text', text: 'Noted: 7.' } },
    })
    emit({ category: 'lifecycle', event: 'prompt_completed', data: { stopReason: 'end_turn' } })
    events.flush()

    expect(readSessionHistory(database, target.threadId)).toEqual([
      { messageId: sent.userMessage.messageId, role: 'user', text: 'Remember the number 7' },
      { messageId: expect.any(String), role: 'assistant', text: 'Noted: 7.' },
    ])
    expect(readSessionHistory(database, 'another-thread')).toEqual([])
  })
})
