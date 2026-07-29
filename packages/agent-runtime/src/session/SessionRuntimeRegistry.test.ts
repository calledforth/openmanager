import type {
  PermissionOutcome,
  PlanReviewOutcome,
  ProviderId,
  ProviderSessionInfo,
  QuestionOutcome,
} from '@agentpack/contract'
import { describe, expect, it, vi } from 'vitest'
import type { BackendEventListener, SessionResult } from '../backends/Backend.js'
import type { SessionRuntimeSpec } from './AcpSessionRuntime.js'
import type {
  ManagedSessionRuntime,
  ManagedSessionRuntimeFactory,
} from './AcpSessionRuntimeImpl.js'
import type { AppliedSessionState } from './AppliedConfigCache.js'
import type {
  DesiredSessionConfig,
  SessionRuntimeExit,
  SessionRuntimePhase,
  TerminationRequest,
  ThreadId,
} from './lifecycle.js'
import { SessionRuntimeRegistryImpl } from './SessionRuntimeRegistryImpl.js'

/** A runtime with no process behind it. The transport seam is already faked
 * one level down (`test-connection.ts`); the registry only cares about
 * identity, start, exit and stop. */
class FakeRuntime implements ManagedSessionRuntime {
  readonly providerId: ProviderId
  readonly cwd: string
  readonly exited: Promise<SessionRuntimeExit>
  phase: SessionRuntimePhase = 'created'
  sessionId: string | undefined
  resumeCursor: string | undefined
  exit: SessionRuntimeExit | undefined
  applied: AppliedSessionState | undefined
  listSessionsAdvertised = false
  starts = 0
  stopped: TerminationRequest | undefined

  private threadIdValue: ThreadId
  private workspaceIdValue: string | undefined
  private resolveExited!: (exit: SessionRuntimeExit) => void
  private readonly listeners = new Set<BackendEventListener>()
  private readonly exitListeners = new Set<(exit: SessionRuntimeExit) => void>()

  constructor(
    readonly spec: SessionRuntimeSpec,
    private readonly startGate?: Promise<void>,
  ) {
    this.providerId = spec.providerId
    this.cwd = spec.cwd
    this.threadIdValue = spec.threadId
    this.workspaceIdValue = spec.workspaceId
    this.resumeCursor = spec.resumeCursor
    this.exited = new Promise((resolve) => {
      this.resolveExited = resolve
    })
  }

  get threadId(): ThreadId {
    return this.threadIdValue
  }
  get workspaceId(): string | undefined {
    return this.workspaceIdValue
  }

  async start(): Promise<SessionResult> {
    this.starts += 1
    if (this.starts > 1) return { sessionId: this.sessionId ?? 'session-1', state: 'reused' }
    this.phase = 'starting'
    // A tick of latency, so concurrent ensures actually overlap. Selected
    // tests can hold this phase open to exercise reaping and eviction races.
    await (this.startGate ?? Promise.resolve())
    this.phase = 'ready'
    this.sessionId = this.spec.sessionId ?? `session-for-${this.threadIdValue}`
    this.emit()
    return { sessionId: this.sessionId, state: this.spec.sessionId ? 'loaded' : 'created' }
  }

  async stop(request: TerminationRequest): Promise<SessionRuntimeExit> {
    this.stopped = request
    return this.die({ expected: true, reason: request.reason })
  }
  dispose(): void {
    void this.stop({ reason: 'disposed' })
  }
  /** The child dying on its own. */
  crash(): SessionRuntimeExit {
    return this.die({ expected: false })
  }

  private die(partial: {
    expected: boolean
    reason?: TerminationRequest['reason']
  }): SessionRuntimeExit {
    if (this.exit) return this.exit
    this.phase = 'exited'
    this.exit = {
      exitCode: 0,
      signal: null,
      forced: false,
      at: new Date().toISOString(),
      ...partial,
    }
    this.resolveExited(this.exit)
    for (const listener of this.exitListeners) listener(this.exit)
    return this.exit
  }

  private emit(): void {
    for (const listener of this.listeners)
      listener({
        threadId: this.threadIdValue,
        workspaceId: this.workspaceIdValue,
        sessionId: this.sessionId,
        category: 'lifecycle',
        event: 'session_created',
        data: { configOptions: [] },
      } as Parameters<BackendEventListener>[0])
  }

  rebindThread(threadId: ThreadId, workspaceId: string | undefined): void {
    this.threadIdValue = threadId
    if (workspaceId !== undefined) this.workspaceIdValue = workspaceId
  }
  events(listener: BackendEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  onExit(listener: (exit: SessionRuntimeExit) => void): () => void {
    this.exitListeners.add(listener)
    return () => this.exitListeners.delete(listener)
  }
  async prompt(): Promise<void> {}
  async cancel(): Promise<void> {}
  async listSessions(): Promise<ProviderSessionInfo[]> {
    return []
  }
  async setModel(): Promise<void> {}
  async setMode(): Promise<void> {}
  async setConfigOption(): Promise<void> {}
  async applyDesiredConfig(_desired: DesiredSessionConfig): Promise<void> {}
  respondPermission(_requestId: string, _outcome: PermissionOutcome): boolean {
    return false
  }
  respondExtension(_requestId: string, _response: unknown): boolean {
    return false
  }
  respondQuestion(_requestId: string, _outcome: QuestionOutcome): boolean {
    return false
  }
  respondPlan(_requestId: string, _outcome: PlanReviewOutcome): boolean {
    return false
  }
}

function build(
  options: {
    limit?: number
    startGate?: (spec: SessionRuntimeSpec, index: number) => Promise<void> | undefined
  } = {},
) {
  const created: FakeRuntime[] = []
  const factory: ManagedSessionRuntimeFactory = {
    create(spec) {
      const runtime = new FakeRuntime(spec, options.startGate?.(spec, created.length))
      created.push(runtime)
      return runtime
    },
  }
  const events: Array<{ providerId: ProviderId; threadId: string }> = []
  const registry = new SessionRuntimeRegistryImpl({
    runtimes: factory,
    onEvent: (providerId, event) => events.push({ providerId, threadId: event.threadId }),
    log: vi.fn(),
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
  })
  return { registry, created, events }
}

const spec = (overrides: Partial<SessionRuntimeSpec> = {}): SessionRuntimeSpec => ({
  threadId: 'thread-1',
  providerId: 'cursor',
  workspaceId: 'C:/workspace',
  cwd: 'C:/workspace',
  ...overrides,
})

describe('SessionRuntimeRegistry', () => {
  it('creates one runtime per thread and reuses it for the same provider and cwd', async () => {
    const { registry, created } = build()
    const first = await registry.ensure(spec())
    const second = await registry.ensure(spec())
    expect(created).toHaveLength(1)
    expect(second).toBe(first)
    expect(created[0].starts).toBe(2)
  })

  it('gives two threads on one provider their own runtimes', async () => {
    const { registry, created } = build()
    await registry.ensure(spec({ threadId: 'thread-1' }))
    await registry.ensure(spec({ threadId: 'thread-2' }))
    expect(created).toHaveLength(2)
    expect(registry.forProvider('cursor')).toHaveLength(2)
  })

  it('shares one in-flight start between concurrent callers', async () => {
    const { registry, created } = build()
    const [a, b] = await Promise.all([registry.ensure(spec()), registry.ensure(spec())])
    expect(created).toHaveLength(1)
    expect(a).toBe(b)
    expect(created[0].starts).toBe(1)
  })

  it('waits for a mismatched in-flight start and supersedes it', async () => {
    const { registry, created } = build()
    const first = registry.ensure(spec({ cwd: 'C:/first' }))
    const second = registry.ensure(spec({ cwd: 'C:/second' }))

    const [firstEntry, secondEntry] = await Promise.all([first, second])

    expect(firstEntry.runtime).toBe(created[0])
    expect(secondEntry.runtime).toBe(created[1])
    expect(created[0].stopped).toEqual({ reason: 'cwd_changed' })
    expect(registry.get('thread-1')?.cwd).toBe('C:/second')
  })

  it('supersedes the runtime when the thread moves to another directory', async () => {
    const { registry, created } = build()
    await registry.ensure(spec())
    await registry.ensure(spec({ cwd: 'C:/other' }))
    expect(created).toHaveLength(2)
    expect(created[0].stopped).toEqual({ reason: 'cwd_changed' })
    // History follows the thread across the respawn.
    expect(created[1].spec.sessionId).toBe('session-for-thread-1')
    expect(registry.get('thread-1')?.cwd).toBe('C:/other')
  })

  it('drops the entry the moment its process exits', async () => {
    const { registry, created } = build()
    const exits: string[] = []
    registry.onRuntimeExit((entry) => exits.push(entry.threadId))
    await registry.ensure(spec())
    created[0].crash()
    expect(registry.get('thread-1')).toBeUndefined()
    expect(exits).toEqual(['thread-1'])
  })

  it('stops forwarding events once a runtime has exited', async () => {
    const { registry, created, events } = build()
    await registry.ensure(spec())
    expect(events).toEqual([{ providerId: 'cursor', threadId: 'thread-1' }])
    created[0].crash()
    await registry.ensure(spec())
    expect(events).toHaveLength(2)
  })

  it('rekeys a provisional thread onto its created session id', async () => {
    const { registry, created } = build()
    await registry.ensure(spec({ threadId: 'provisional' }))
    const moved = registry.rekey('provisional', 'session-for-provisional', 'C:/workspace')
    expect(moved?.threadId).toBe('session-for-provisional')
    expect(registry.get('provisional')).toBeUndefined()
    expect(registry.get('session-for-provisional')?.runtime).toBe(created[0])
    expect(created[0].threadId).toBe('session-for-provisional')
  })

  it('finds the entry owning an ACP session id', async () => {
    const { registry } = build()
    await registry.ensure(spec({ threadId: 'provisional' }))
    expect(registry.findBySession('cursor', 'session-for-provisional')?.threadId).toBe(
      'provisional',
    )
    expect(registry.findBySession('opencode', 'session-for-provisional')).toBeUndefined()
  })

  it('never reports a runtime with an active turn as idle', async () => {
    const { registry } = build()
    await registry.ensure(spec())
    registry.beginTurn('thread-1', { userMessageId: 'user-1', startedAt: 0 })
    expect(registry.idleSince(0, Date.now() + 1_000)).toHaveLength(0)
    registry.endTurn('thread-1')
    expect(registry.idleSince(0, Date.now() + 1_000)).toHaveLength(1)
  })

  it('does not reap a runtime while start is in flight', async () => {
    let releaseStart: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      releaseStart = resolve
    })
    const { registry, created } = build({ startGate: () => gate })
    const starting = registry.ensure(spec())
    await vi.waitFor(() => expect(created[0]?.phase).toBe('starting'))

    await expect(registry.reapIdle(0, Date.now() + 60_000)).resolves.toEqual([])
    expect(created[0]?.stopped).toBeUndefined()

    releaseStart?.()
    await starting
  })

  it('forgets a runtime whose start failed so a retry gets a fresh process', async () => {
    const { registry } = build()
    const failing: ManagedSessionRuntimeFactory = {
      create(runtimeSpec) {
        const runtime = new FakeRuntime(runtimeSpec)
        runtime.start = async () => {
          throw new Error('handshake failed')
        }
        return runtime
      },
    }
    const failingRegistry = new SessionRuntimeRegistryImpl({
      runtimes: failing,
      onEvent: vi.fn(),
      log: vi.fn(),
    })
    await expect(failingRegistry.ensure(spec())).rejects.toThrow('handshake failed')
    expect(failingRegistry.get('thread-1')).toBeUndefined()
  })

  it('reaps only what is still idle when the kill actually happens', async () => {
    const { registry, created } = build()
    await registry.ensure(spec({ threadId: 'thread-1' }))
    await registry.ensure(spec({ threadId: 'thread-2' }))
    await registry.ensure(spec({ threadId: 'thread-3' }))

    // Stopping thread-1 awaits its child's death, and a prompt lands on
    // thread-2 during that await. Both are candidates from the same snapshot,
    // so only re-checking at the moment of the kill can save thread-2 — this
    // is invariant 10 in the window the reaper actually runs in.
    created[0].stop = async (request) => {
      created[0].stopped = request
      registry.beginTurn('thread-2', { userMessageId: 'user-1', startedAt: Date.now() })
      return created[0].crash()
    }

    await expect(registry.reapIdle(0, Date.now() + 1_000)).resolves.toEqual([
      'thread-1',
      'thread-3',
    ])
    expect(registry.get('thread-2')?.runtime).toBe(created[1])
    expect(created[1].stopped).toBeUndefined()
    expect(created[2].stopped).toEqual({ reason: 'reaped' })
  })

  it('leaves a thread alone when activity lands on it mid-sweep', async () => {
    const { registry, created } = build()
    await registry.ensure(spec({ threadId: 'thread-1' }))
    await registry.ensure(spec({ threadId: 'thread-2' }))
    created[0].stop = async (request) => {
      created[0].stopped = request
      // No turn, just a config write or an inbound event on the other thread.
      registry.touch('thread-2')
      return created[0].crash()
    }

    await expect(registry.reapIdle(0, Date.now() + 1_000)).resolves.toEqual(['thread-1'])
    expect(created[1].stopped).toBeUndefined()
  })

  it('evicts the least recently used runtime once the cap is reached', async () => {
    const { registry, created } = build({ limit: 2 })
    await registry.ensure(spec({ threadId: 'thread-1' }))
    await registry.ensure(spec({ threadId: 'thread-2' }))
    registry.touch('thread-1', Date.now() + 1_000)

    await registry.ensure(spec({ threadId: 'thread-3' }))

    expect(created[1].stopped).toEqual({ reason: 'evicted' })
    expect(registry.get('thread-2')).toBeUndefined()
    expect(
      registry
        .entries()
        .map((entry) => entry.threadId)
        .sort(),
    ).toEqual(['thread-1', 'thread-3'])
  })

  it('exceeds the cap rather than evicting a runtime while it starts', async () => {
    let releaseStart: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      releaseStart = resolve
    })
    const { registry, created } = build({
      limit: 1,
      startGate: (runtimeSpec) => (runtimeSpec.threadId === 'thread-1' ? gate : undefined),
    })
    const starting = registry.ensure(spec({ threadId: 'thread-1' }))
    await vi.waitFor(() => expect(created[0]?.phase).toBe('starting'))

    await registry.ensure(spec({ threadId: 'thread-2' }))
    expect(created[0]?.stopped).toBeUndefined()
    expect(registry.entries()).toHaveLength(2)

    releaseStart?.()
    await starting
  })

  it('exceeds the cap rather than evicting a runtime mid-turn', async () => {
    const { registry, created } = build({ limit: 2 })
    await registry.ensure(spec({ threadId: 'thread-1' }))
    await registry.ensure(spec({ threadId: 'thread-2' }))
    registry.beginTurn('thread-1', { userMessageId: 'user-1', startedAt: 0 })
    registry.beginTurn('thread-2', { userMessageId: 'user-2', startedAt: 0 })

    await registry.ensure(spec({ threadId: 'thread-3' }))

    expect(created.map((runtime) => runtime.stopped)).toEqual([undefined, undefined, undefined])
    expect(registry.entries()).toHaveLength(3)
  })

  it('waits for every child to be gone on shutdown, including mid-turn ones', async () => {
    const { registry, created } = build()
    await registry.ensure(spec({ threadId: 'thread-1' }))
    await registry.ensure(spec({ threadId: 'thread-2' }))
    registry.beginTurn('thread-2', { userMessageId: 'user-1', startedAt: 0 })

    await registry.shutdown({ reason: 'disposed' })

    expect(created.map((runtime) => runtime.exit?.expected)).toEqual([true, true])
    expect(registry.entries()).toHaveLength(0)
  })

  it('still awaits the rest when one runtime refuses to stop', async () => {
    const { registry, created } = build()
    await registry.ensure(spec({ threadId: 'thread-1' }))
    await registry.ensure(spec({ threadId: 'thread-2' }))
    created[0].stop = async () => {
      throw new Error('terminate failed')
    }

    await expect(registry.shutdown({ reason: 'disposed' })).resolves.toBeUndefined()
    expect(created[1].stopped).toEqual({ reason: 'disposed' })
  })

  it('disposes everything it owns', async () => {
    const { registry, created } = build()
    await registry.ensure(spec({ threadId: 'thread-1' }))
    await registry.ensure(spec({ threadId: 'thread-2' }))
    registry.disposeAll()
    expect(created.map((runtime) => runtime.stopped)).toEqual([
      { reason: 'disposed' },
      { reason: 'disposed' },
    ])
    expect(registry.entries()).toHaveLength(0)
  })
})
