import { describe, expect, it } from 'vitest'
import { createMockEnvironmentClient, type MockSeed } from '@openmanager/environment-client'
import { createSidebarRowsReader } from '../src/providers/sidebar-rows'

const WORKSPACE = {
  workspaceId: 'C:/repo',
  name: 'repo',
  path: 'C:/repo',
  lastUsedAt: null,
  lastActivityAt: null,
  capabilities: { git: false },
  exists: true,
}
const SESSION = { sessionId: 'session-1', workspaceId: WORKSPACE.workspaceId, title: 'First' }
const THREAD = { threadId: 'thread-1', sessionId: SESSION.sessionId }
const SEED: MockSeed = {
  environment: { environmentId: 'env-a', name: 'A' },
  workspaces: [WORKSPACE],
  sessions: [{ session: SESSION, threads: [THREAD] }],
}

function connected(seed: MockSeed = SEED) {
  const client = createMockEnvironmentClient({ seed, respond: () => null })
  client.connect()
  return client
}

describe('createSidebarRowsReader', () => {
  it('reads nothing of an environment it has not heard from', () => {
    const client = createMockEnvironmentClient({
      seed: { ...SEED, environment: undefined },
    })
    const state = client.getState()
    const read = createSidebarRowsReader()
    expect(read({ ...client, getState: () => ({ ...state, environment: null }) })).toBeNull()
  })

  it('stamps every row with its environment', async () => {
    const client = connected()
    await client.commands.saveDraft({
      draftId: 'draft-1',
      baseRevision: 0,
      target: { type: 'new_session', sessionId: 'next', workspaceId: WORKSPACE.workspaceId },
      content: { text: 'Unsent' },
    })
    await client.settle()
    const rows = createSidebarRowsReader()(client)!
    expect(rows.environmentId).toBe('env-a')
    expect(rows.sessions['C:/repo']).toMatchObject([
      { externalId: 'session-1', environmentId: 'env-a', title: 'First' },
    ])
    expect(rows.drafts).toMatchObject([{ draftId: 'draft-1', environmentId: 'env-a' }])
  })

  it('is the same object for as long as nothing it shows has changed', async () => {
    const client = connected()
    const read = createSidebarRowsReader()
    const target = { sessionId: SESSION.sessionId, threadId: THREAD.threadId }
    const { turn } = await client.commands.sendTurn({ ...target, text: 'Go on' })
    await client.settle()
    const rows = read(client)

    const before = client.getState()
    for (let token = 0; token < 5; token += 1) {
      client.streamAssistantText({ ...target, turnId: turn.turnId }, 'word ', 'streamed')
    }
    await client.settle()
    expect(client.getState()).not.toBe(before)
    expect(read(client)).toBe(rows)
  })

  it('moves on when a row does', async () => {
    const client = connected()
    const read = createSidebarRowsReader()
    const rows = read(client)!
    await client.commands.renameSession(SESSION.sessionId, 'Second')
    const next = read(client)!
    expect(next).not.toBe(rows)
    expect(next.sessions['C:/repo']?.[0]?.title).toBe('Second')
    expect(next.workspaces).toBe(rows.workspaces)
    expect(next.drafts).toBe(rows.drafts)
  })

  it('offers no settling until the environment is connected', () => {
    const client = createMockEnvironmentClient({ seed: SEED })
    const state = client.getState()
    const offline = {
      ...client,
      getState: () => ({ ...state, connection: { ...state.connection, phase: 'closed' as const } }),
    }
    expect(createSidebarRowsReader()(offline)?.canSettle).toBe(false)
    expect(createSidebarRowsReader()(connected())?.canSettle).toBe(true)
  })
})
