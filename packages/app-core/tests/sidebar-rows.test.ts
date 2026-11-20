import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '@openmanager/protocol'
import { createMockEnvironmentClient, type MockSeed } from '@openmanager/environment-client'
import { createSidebarRowsReader, groupSidebarSessions } from '../src/providers/sidebar-rows'

describe('groupSidebarSessions', () => {
  const summary = (patch: Partial<SessionSummary> & { sessionId: string }): SessionSummary => ({
    workspaceId: 'C:/repo',
    title: patch.sessionId,
    status: 'idle',
    providerId: 'claude',
    updatedAt: '2026-11-19T10:00:00.000Z',
    ...patch,
  })
  const rows = (sessions: SessionSummary[]) =>
    groupSidebarSessions({ sessions, unsent: [], workspaces: [], environmentId: 'env-a' })[
      'C:/repo'
    ] ?? []
  const subagent = (sessionId: string, parentSessionId: string, status = 'idle') =>
    summary({
      sessionId,
      parentSessionId,
      status: status as SessionSummary['status'],
      subagent: { subagentId: `sa-${sessionId}`, origin: 'native', promptable: false },
    })

  it('gives subagents no rows, and counts them on their parent', () => {
    const shown = rows([
      summary({ sessionId: 'parent', status: 'running' }),
      subagent('a', 'parent', 'running'),
      subagent('b', 'parent', 'waiting'),
      subagent('c', 'parent'),
      // A subagent's own subagent is its parent's to count, not the session's.
      subagent('d', 'a', 'running'),
      // A child that is not a subagent keeps its row under its parent.
      summary({ sessionId: 'fork', parentSessionId: 'parent' }),
    ])
    expect(shown.map((row) => row.externalId)).toEqual(['parent', 'fork'])
    expect(shown[0]).toMatchObject({ subagentCount: 3, subagentsLive: 2 })
    expect(shown[1]).not.toHaveProperty('subagentCount')
  })

  it('names background work without subagents, and says when they are all of it', () => {
    const agent = { taskId: 't-agent', kind: 'agent' as const, description: 'Map callers' }
    const shell = { taskId: 't-shell', kind: 'shell' as const, description: 'pnpm test' }
    const [onlyAgents] = rows([
      summary({ sessionId: 'p', status: 'running', inBackground: true, backgroundTasks: [agent] }),
      subagent('a', 'p', 'running'),
    ])
    expect(onlyAgents).toMatchObject({ status: 'running', inBackgroundForSubagents: true })
    expect(onlyAgents).not.toHaveProperty('backgroundTaskCount')

    const [mixed] = rows([
      summary({
        sessionId: 'p',
        status: 'running',
        inBackground: true,
        backgroundTasks: [agent, shell],
      }),
      subagent('a', 'p', 'running'),
    ])
    expect(mixed).toMatchObject({ backgroundTaskCount: 1, backgroundTaskNames: 'pnpm test' })
    expect(mixed).not.toHaveProperty('inBackgroundForSubagents')

    // An agent task no live subagent accounts for has no card: it stays named.
    const [uncounted] = rows([
      summary({ sessionId: 'p', status: 'running', inBackground: true, backgroundTasks: [agent] }),
    ])
    expect(uncounted).toMatchObject({ backgroundTaskCount: 1, backgroundTaskNames: 'Map callers' })
    expect(uncounted).not.toHaveProperty('inBackgroundForSubagents')
  })

  it('shows a session done beside background work that just runs on, still in the background', () => {
    const shell = { taskId: 't-shell', kind: 'shell' as const, description: 'npm run dev' }
    const [doneBeside] = rows([
      summary({
        sessionId: 'p',
        providerId: 'codex',
        status: 'running',
        inBackground: true,
        doneAt: '2026-11-19T10:05:00.000Z',
        backgroundTasks: [shell],
      }),
    ])
    expect(doneBeside).toMatchObject({
      status: 'done',
      inBackground: true,
      backgroundTaskCount: 1,
      backgroundTaskNames: 'npm run dev',
    })
    // Without news, background work alone reads as background work.
    const [working] = rows([
      summary({ sessionId: 'p', status: 'running', inBackground: true, backgroundTasks: [shell] }),
    ])
    expect(working).toMatchObject({ status: 'running', inBackground: true })
    // A turn in flight is never done, whatever an earlier one left behind.
    const [turn] = rows([
      summary({ sessionId: 'p', status: 'running', doneAt: '2026-11-19T10:05:00.000Z' }),
    ])
    expect(turn).toMatchObject({ status: 'running' })
  })

  it('counts a parent live while a subagent of its subagent works, and names them all', () => {
    const [parent] = rows([
      summary({ sessionId: 'parent' }),
      subagent('a', 'parent'),
      subagent('d', 'a', 'running'),
    ])
    expect(parent).toMatchObject({
      subagentCount: 1,
      subagentsLive: 1,
      subagentSessionIds: 'a\nd',
    })
  })
})

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
