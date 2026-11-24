import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Subagent } from '@openmanager/protocol/node'
import {
  createSpawnAgentTools,
  LIST_AGENTS_MAX,
  SPAWN_RUNNING_MAX,
  type ActiveAgent,
  type SpawnCaller,
  type SpawnHost,
} from '../src/subagents/spawn-tools.js'
import { createSubagentWake, wakeMessage } from '../src/subagents/subagent-wake.js'

const caller: SpawnCaller = {
  sessionId: 'parent',
  providerId: 'claude',
  turnId: 'turn-1',
  depth: 0,
}

function record(overrides: Partial<Subagent> = {}): Subagent {
  return {
    subagentId: 'sub-1',
    parentSessionId: 'parent',
    turnId: 'turn-1',
    depth: 1,
    origin: 'openmanager',
    providerId: 'opencode',
    title: 'Review the parser',
    status: 'running',
    background: true,
    childSessionId: 'child-1',
    promptable: true,
    stoppable: true,
    stats: {},
    startedAt: '2026-11-18T00:00:00.000Z',
    updatedAt: '2026-11-18T00:00:00.000Z',
    ...overrides,
  }
}

function fakeHost(overrides: Partial<SpawnHost> = {}): SpawnHost {
  const children: Subagent[] = []
  return {
    callerOf: () => caller,
    providers: () => [
      {
        providerId: 'opencode',
        name: 'OpenCode',
        available: true,
        models: [{ modelId: 'sonnet', name: 'Sonnet' }],
        defaultModelId: 'sonnet',
      },
      { providerId: 'cursor', name: 'Cursor', available: false, models: [] },
    ],
    spawn: vi.fn(async (args) => {
      const child = record({ subagentId: `sub-${children.length + 1}`, title: args.title })
      children.push(child)
      return child
    }),
    list: () => children,
    subagentsOf: (sessionId) => children.filter((child) => child.parentSessionId === sessionId),
    activeAgents: () => [],
    get: (_parent, id) => children.find((child) => child.subagentId === id),
    waitSettled: async (_parent, id) => children.find((child) => child.subagentId === id)!,
    resultOf: () => undefined,
    markDelivered: vi.fn(),
    send: async () => 'started',
    stop: async () => undefined,
    ...overrides,
  }
}

const tool = (host: SpawnHost, name: string) =>
  createSpawnAgentTools(host).find((candidate) => candidate.name === name)!
const ctx = { threadId: 'thread-1', providerId: 'claude' as const }

describe('spawn_agent', () => {
  it('starts a child in the background by default and says it will be told', async () => {
    const host = fakeHost()
    const result = await tool(host, 'spawn_agent').call(
      { provider: 'opencode', prompt: 'Review src/parser.ts', title: 'Review the parser' },
      ctx,
    )
    expect(result.isError).toBeUndefined()
    expect(result.text).toContain('sub-1 [running]')
    expect(result.text).toContain('do not poll')
    expect(host.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'opencode', background: true, parent: caller }),
    )
    // No model asked for: the child runs on what a person's chat there would.
    expect(host.spawn).toHaveBeenCalledWith(expect.not.objectContaining({ modelId: 'sonnet' }))
  })

  it('refuses an unknown or unavailable provider and lists the real ones', async () => {
    const host = fakeHost()
    const unknown = await tool(host, 'spawn_agent').call(
      { provider: 'gpt', prompt: 'x', title: 'x' },
      ctx,
    )
    expect(unknown.isError).toBe(true)
    expect(unknown.text).toContain('- opencode: OpenCode')
    const down = await tool(host, 'spawn_agent').call(
      { provider: 'cursor', prompt: 'x', title: 'x' },
      ctx,
    )
    expect(down.isError).toBe(true)
    expect(down.text).toContain('not available')
    expect(host.spawn).not.toHaveBeenCalled()
  })

  it('refuses a model the provider does not offer', async () => {
    const host = fakeHost()
    const result = await tool(host, 'spawn_agent').call(
      { provider: 'opencode', model: 'nope', prompt: 'x', title: 'x' },
      ctx,
    )
    expect(result.isError).toBe(true)
    expect(result.text).toContain('sonnet')
  })

  it('caps depth and running children', async () => {
    const deep = fakeHost({ callerOf: () => ({ ...caller, depth: 2 }) })
    const tooDeep = await tool(deep, 'spawn_agent').call(
      { provider: 'opencode', prompt: 'x', title: 'x' },
      ctx,
    )
    expect(tooDeep.isError).toBe(true)

    const busy = fakeHost({
      list: () =>
        Array.from({ length: SPAWN_RUNNING_MAX }, (_, i) =>
          record({ subagentId: `s${i}`, turnId: 'old' }),
        ),
    })
    const result = await tool(busy, 'spawn_agent').call(
      { provider: 'opencode', prompt: 'x', title: 'x' },
      ctx,
    )
    expect(result.isError).toBe(true)
    expect(result.text).toContain('still running')
  })

  it('waits in the foreground and marks the answer read so nothing wakes for it', async () => {
    const host = fakeHost({
      waitSettled: async () => record({ status: 'completed', result: 'short' }),
      resultOf: () => 'The parser looks fine.',
    })
    const result = await tool(host, 'spawn_agent').call(
      { provider: 'opencode', prompt: 'x', title: 'x', background: false },
      ctx,
    )
    expect(result.text).toContain('The parser looks fine.')
    expect(host.markDelivered).toHaveBeenCalledWith('parent', 'sub-1')
  })

  it('returns the handle when a foreground wait runs out', async () => {
    const host = fakeHost()
    const result = await tool(host, 'spawn_agent').call(
      { provider: 'opencode', prompt: 'x', title: 'x', background: false },
      ctx,
    )
    expect(result.isError).toBeUndefined()
    expect(result.text).toContain('Still running after 45 s')
    expect(host.markDelivered).not.toHaveBeenCalled()
  })
})

describe('wait_agent, send_agent, list_agents, stop_agent', () => {
  it('refuses an id that is not this session’s', async () => {
    const host = fakeHost()
    for (const name of ['wait_agent', 'send_agent', 'stop_agent']) {
      const result = await tool(host, name).call({ id: 'other', message: 'hi' }, ctx)
      expect(result.isError).toBe(true)
    }
  })

  it('lists children and providers', async () => {
    const host = fakeHost({ subagentsOf: (id) => (id === 'parent' ? [record()] : []) })
    const result = await tool(host, 'list_agents').call({}, ctx)
    expect(result.text).toContain('- Review the parser [running')
    expect(result.text).toContain('id: sub-1 (session child-1)')
    expect(result.text).toContain('- cursor (unavailable)')
  })

  it('takes a child by its session id as well as its subagent id', async () => {
    const send = vi.fn(async () => 'started' as const)
    const stop = vi.fn(async () => undefined)
    const waitSettled = vi.fn(async () => record({ status: 'completed', result: 'Done.' }))
    const host = fakeHost({
      list: () => [record()],
      get: (_parent, id) => (id === 'sub-1' ? record() : undefined),
      send,
      stop,
      waitSettled,
    })
    const sent = await tool(host, 'send_agent').call({ id: 'child-1', message: 'More' }, ctx)
    expect(sent.isError).toBeUndefined()
    expect(send).toHaveBeenCalledWith('parent', 'sub-1', 'More')
    const waited = await tool(host, 'wait_agent').call({ id: 'child-1' }, ctx)
    expect(waited.text).toContain('Done.')
    expect(waitSettled).toHaveBeenCalledWith('parent', 'sub-1', 45_000)
    await tool(host, 'stop_agent').call({ id: 'child-1' }, ctx)
    expect(stop).toHaveBeenCalledWith('parent', 'sub-1')
    const missing = await tool(host, 'send_agent').call({ id: 'child-9', message: 'x' }, ctx)
    expect(missing.isError).toBe(true)
    expect(missing.text).toContain('list_agents')
  })

  it('stop marks the child delivered so it does not wake the parent', async () => {
    const stop = vi.fn(async () => undefined)
    const host = fakeHost({ list: () => [record()], get: () => record(), stop })
    await tool(host, 'stop_agent').call({ id: 'sub-1' }, ctx)
    expect(stop).toHaveBeenCalledWith('parent', 'sub-1')
    expect(host.markDelivered).toHaveBeenCalledWith('parent', 'sub-1')
  })
})

describe('list_agents', () => {
  afterEach(() => vi.useRealTimers())

  /** A lineage: two children of ours (one settled), a native one, and a grandchild. */
  const lineage: Record<string, Subagent[]> = {
    parent: [
      record({
        subagentId: 'old',
        childSessionId: 'child-old',
        title: 'Earlier check',
        status: 'completed',
        stats: { durationMs: 62_000, toolCalls: 4 },
        startedAt: '2026-11-18T09:00:00.000Z',
        finishedAt: '2026-11-18T09:01:02.000Z',
      }),
      record({
        subagentId: 'sub-1',
        childSessionId: 'child-1',
        providerId: 'codex',
        modelId: 'gpt-5.5',
        title: 'Review the parser',
        prompt: `Review src/parser.ts\nand report every bug. ${'Be thorough. '.repeat(20)}`,
        activity: 'Read src/parser.ts',
        stats: { toolCalls: 3 },
        startedAt: '2026-11-18T09:58:00.000Z',
      }),
      record({
        subagentId: 'nat-1',
        origin: 'native',
        agentType: 'Explore',
        providerId: 'claude',
        childSessionId: 'native-child',
        title: 'Find the callers',
        status: 'waiting',
        waitingOn: 'permission',
        promptable: false,
        startedAt: '2026-11-18T09:59:30.000Z',
      }),
    ],
    'child-1': [
      record({
        subagentId: 'grand',
        parentSessionId: 'child-1',
        childSessionId: 'grand-child',
        depth: 2,
        providerId: 'cursor',
        title: 'Check the tests',
        startedAt: '2026-11-18T09:59:00.000Z',
      }),
    ],
  }

  it('shows the whole lineage as a tree, live first, with what each is doing and who can act on it', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-11-18T10:00:00.000Z') })
    const host = fakeHost({ subagentsOf: (id) => lineage[id] ?? [] })
    const { text } = await tool(host, 'list_agents').call({}, ctx)
    expect(text).toContain('Subagents of this session, live first (3 live, 1 finished):')
    expect(text).toContain(
      '- Review the parser [running, 2m 00s, 3 tool calls] codex/gpt-5.5 · spawn_agent\n' +
        '  id: sub-1 (session child-1) · yours: send_agent, wait_agent, stop_agent\n',
    )
    // Nested under its parent, and only that subagent can act on it.
    expect(text).toContain(
      '  - Check the tests [running, 1m 00s] cursor · spawn_agent\n' +
        '    id: grand (session grand-child) · started by a subagent of yours: only that subagent can act on it',
    )
    expect(text).toContain(
      "- Find the callers [waiting on permission, 30s] claude · its provider's own subagent (Explore)\n" +
        '  id: nat-1 (session native-child) · reach it with your own subagent tool, not send_agent',
    )
    expect(text).toContain('  now: Read src/parser.ts')
    // The prompt is one line, cut.
    const asked = text.split('\n').find((line) => line.startsWith('  asked: Review src/parser.ts and'))
    expect(asked).toBeDefined()
    expect(asked!.length).toBeLessThanOrEqual('  asked: '.length + 160)
    expect(asked!.endsWith('…')).toBe(true)
    // Live ones lead; the settled one comes last, with how long it took.
    expect(text.indexOf('Review the parser')).toBeLessThan(text.indexOf('Earlier check'))
    expect(text.indexOf('Find the callers')).toBeLessThan(text.indexOf('Earlier check'))
    expect(text).toContain('- Earlier check [completed, 1m 02s, 4 tool calls] opencode · spawn_agent')
    expect(text).toContain('Providers for spawn_agent:\n- opencode: OpenCode')
  })

  it('says when there are none', async () => {
    const { text } = await tool(fakeHost(), 'list_agents').call({}, ctx)
    expect(text).toContain('Subagents: none yet.')
  })

  it('caps a long list', async () => {
    const many = Array.from({ length: LIST_AGENTS_MAX + 5 }, (_, i) =>
      record({ subagentId: `s${i}`, childSessionId: `c${i}`, title: `Job ${i}` }),
    )
    const host = fakeHost({ subagentsOf: (id) => (id === 'parent' ? many : []) })
    const { text } = await tool(host, 'list_agents').call({}, ctx)
    expect(text).toContain('+5 more not shown.')
    expect(text).toContain(`(${LIST_AGENTS_MAX + 5} live, 0 finished)`)
  })
})

describe('list_active_agents', () => {
  afterEach(() => vi.useRealTimers())

  const agent = (overrides: Partial<ActiveAgent> & { id: string }): ActiveAgent => ({
    sessionId: overrides.id,
    workspaceId: 'ws-app',
    projectName: 'app',
    title: overrides.id,
    providerId: 'claude',
    live: true,
    status: 'running',
    ...overrides,
  })
  /** The caller is a subagent of `boss`, beside a sibling, with a child and grandchild of its own. */
  const me: SpawnCaller = {
    sessionId: 'me',
    providerId: 'claude',
    depth: 1,
    workspaceId: 'ws-app',
    parentSessionId: 'boss',
  }
  const world: ActiveAgent[] = [
    agent({ id: 'boss', title: 'Ship the release', live: false, status: 'idle' }),
    agent({
      id: 'me',
      parentSessionId: 'boss',
      subagentId: 'sub-me',
      origin: 'openmanager',
      title: 'Fix the login bug',
      modelId: 'opus',
      startedAt: '2026-11-18T09:55:00.000Z',
      activity: 'Edit src/auth.ts',
    }),
    agent({
      id: 'sib',
      parentSessionId: 'boss',
      subagentId: 'sub-sib',
      origin: 'openmanager',
      providerId: 'codex',
      title: 'Update the changelog',
      status: 'waiting',
      waitingOn: 'permission',
      prompt: 'Add the 0.21 entries to CHANGELOG.md',
      startedAt: '2026-11-18T09:59:00.000Z',
    }),
    agent({
      id: 'kid',
      parentSessionId: 'me',
      subagentId: 'sub-kid',
      origin: 'openmanager',
      providerId: 'opencode',
      title: 'Review the parser',
      prompt: 'Review src/parser.ts and report bugs',
      activity: 'Read src/parser.ts',
      startedAt: '2026-11-18T09:58:00.000Z',
    }),
    agent({
      id: 'grandkid',
      parentSessionId: 'kid',
      subagentId: 'sub-grandkid',
      origin: 'native',
      agentType: 'Explore',
      providerId: 'opencode',
      title: 'Find the callers',
    }),
    agent({
      id: 'other',
      workspaceId: 'ws-site',
      projectName: 'site',
      providerId: 'cursor',
      title: 'Redesign the landing page',
      inBackground: true,
      activity: 'npm run dev',
    }),
  ]
  const run = (agents: readonly ActiveAgent[], input: Record<string, unknown> = {}, caller = me) =>
    tool(
      fakeHost({ callerOf: () => caller, activeAgents: () => agents }),
      'list_active_agents',
    ).call(input, ctx)

  it('shows every live agent as trees by project, with its relation to the caller', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-11-18T10:00:00.000Z') })
    const { text } = await run(world)
    expect(text).toContain('Agents running now in this environment: 5 live, 1 idle shown for context.')
    expect(text).toContain(
      'Project app:\n' +
        '- Ship the release [idle, shown for the agents under it] claude · your parent\n' +
        '  id: boss\n' +
        '  - Fix the login bug [running, 5m 00s] claude/opus · you\n' +
        '    id: me, subagent sub-me started with spawn_agent\n' +
        '    now: Edit src/auth.ts\n' +
        '    - Review the parser [running, 2m 00s] opencode · your subagent (yours to act on)\n' +
        '      id: kid, subagent sub-kid started with spawn_agent\n' +
        '      for: Review src/parser.ts and report bugs\n' +
        '      now: Read src/parser.ts\n' +
        "      - Find the callers [running] opencode · your subagent's subagent\n" +
        "        id: grandkid, Explore subagent sub-grandkid of its provider's own\n" +
        '  - Update the changelog [waiting on permission, 1m 00s] codex · sibling\n',
    )
    expect(text).toContain(
      'Project site:\n- Redesign the landing page [running in background] cursor\n  id: other\n  now: npm run dev',
    )
    // The caller's project comes first.
    expect(text.indexOf('Project app:')).toBeLessThan(text.indexOf('Project site:'))
  })

  it("limits to the caller's project on request", async () => {
    const { text } = await run(world, { scope: 'project' })
    expect(text).toContain('in this project')
    expect(text).not.toContain('Redesign the landing page')
    expect(text).toContain('Review the parser')
  })

  it('says clearly when nothing else is running', async () => {
    const alone = await run([agent({ id: 'me', parentSessionId: undefined })], {}, {
      ...me,
      parentSessionId: undefined,
    })
    expect(alone.text).toBe(
      'Nothing else is running in this environment right now: no other session and no subagent.',
    )
    // Others elsewhere do not count for `project`.
    const elsewhere = await run(
      [agent({ id: 'me' }), agent({ id: 'x', workspaceId: 'ws-site', projectName: 'site' })],
      { scope: 'project' },
      { ...me, parentSessionId: undefined },
    )
    expect(elsewhere.text).toContain('Nothing else is running in this project right now')
  })

  it('caps the listing and says how many more there are', async () => {
    const many = Array.from({ length: LIST_AGENTS_MAX + 12 }, (_, i) =>
      agent({ id: `s${String(i).padStart(3, '0')}`, startedAt: `2026-11-18T09:${String(i % 60).padStart(2, '0')}:00.000Z` }),
    )
    const { text } = await run(many, {}, { ...me, parentSessionId: undefined })
    expect(text).toContain(`${LIST_AGENTS_MAX + 12} live`)
    expect(text).toContain('+12 more not shown.')
    expect(text.split('\n').filter((line) => line.startsWith('- ')).length).toBe(LIST_AGENTS_MAX)
  })
})

describe('subagent wake', () => {
  function harness() {
    const records = new Map<string, Subagent>()
    const enqueue = vi.fn((_parent: string, _text: string, _ids: readonly string[]) => true)
    let fire: (() => void) | undefined
    const wake = createSubagentWake({
      enqueue,
      get: (_parent, id) => records.get(id),
      resultOf: () => undefined,
      setTimer: (run) => {
        fire = run
        return { cancel: () => (fire = undefined) }
      },
    })
    const settle = (child: Subagent) => {
      records.set(child.subagentId, child)
      wake.observe(child)
    }
    return { wake, enqueue, settle, flush: () => fire?.() }
  }

  it('wakes once for children that settle together', () => {
    const { enqueue, settle, flush } = harness()
    settle(record({ subagentId: 'a', status: 'completed', result: 'A done' }))
    settle(record({ subagentId: 'b', status: 'failed', statusReason: 'crashed' }))
    flush()
    expect(enqueue).toHaveBeenCalledTimes(1)
    const [parent, text, ids] = enqueue.mock.calls[0]!
    expect(parent).toBe('parent')
    expect(ids).toEqual(['a', 'b'])
    expect(text).toContain('Subagents finished: Review the parser (completed), Review the parser (failed).')
    expect(text).toContain('A done')
    expect(text).toContain('Reason: crashed')
  })

  it('does not wake for a delivered, cancelled, running or native child', () => {
    const { wake, enqueue, settle, flush } = harness()
    wake.markDelivered('parent', 'read')
    settle(record({ subagentId: 'read', status: 'completed' }))
    settle(record({ subagentId: 'stopped', status: 'cancelled' }))
    settle(record({ subagentId: 'busy', status: 'running' }))
    settle(record({ subagentId: 'native', origin: 'native', status: 'completed' }))
    flush()
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('wakes again after a follow-up reopens a child', () => {
    const { wake, enqueue, settle, flush } = harness()
    settle(record({ status: 'completed' }))
    flush()
    settle(record({ status: 'completed' }))
    flush()
    expect(enqueue).toHaveBeenCalledTimes(1)
    wake.reopen('parent', 'sub-1')
    settle(record({ status: 'completed' }))
    flush()
    expect(enqueue).toHaveBeenCalledTimes(2)
  })

  it('cuts a long answer and points at wait_agent', () => {
    const text = wakeMessage([record({ status: 'completed' })], () => 'x'.repeat(10_000))
    expect(text.length).toBeLessThan(6_000)
    expect(text).toContain('wait_agent with id sub-1')
  })
})
