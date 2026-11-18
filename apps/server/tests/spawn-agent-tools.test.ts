import { describe, expect, it, vi } from 'vitest'
import type { Subagent } from '@openmanager/protocol/node'
import {
  createSpawnAgentTools,
  SPAWN_RUNNING_MAX,
  type SpawnCaller,
  type SpawnHost,
} from '../src/subagents/spawn-tools.js'
import { createSubagentWake, wakeMessage } from '../src/subagents/subagent-wake.js'

const caller: SpawnCaller = { sessionId: 'parent', providerId: 'claude', turnId: 'turn-1', depth: 0 }

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
    const host = fakeHost({ list: () => [record()] })
    const result = await tool(host, 'list_agents').call({}, ctx)
    expect(result.text).toContain('sub-1 [running]')
    expect(result.text).toContain('- cursor (unavailable)')
  })

  it('stop marks the child delivered so it does not wake the parent', async () => {
    const stop = vi.fn(async () => undefined)
    const host = fakeHost({ list: () => [record()], get: () => record(), stop })
    await tool(host, 'stop_agent').call({ id: 'sub-1' }, ctx)
    expect(stop).toHaveBeenCalledWith('parent', 'sub-1')
    expect(host.markDelivered).toHaveBeenCalledWith('parent', 'sub-1')
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
    expect(text).toContain('2 subagents you started have finished')
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
