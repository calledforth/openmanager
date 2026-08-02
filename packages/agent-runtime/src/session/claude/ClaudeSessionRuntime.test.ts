import { describe, expect, it, vi } from 'vitest'
import type { BackendEvent } from '../../backends/Backend.js'
import { InteractionBroker } from '../../core/InteractionBroker.js'
import { PermissionBroker } from '../../core/PermissionBroker.js'
import { claude } from '../../providers/claude.js'
import type { RuntimeTimeouts } from '../constants.js'
import type { SessionRuntimeExit } from '../lifecycle.js'
import type { SessionRuntimeSpec } from '../SessionRuntime.js'
import { ClaudeSessionRuntime } from './ClaudeSessionRuntime.js'
import { FakeClaudeSdk } from './test-sdk.js'

const SPEC = {
  threadId: 'thread-1',
  workspaceId: 'workspace-1',
  cwd: 'C:/workspace',
  providerId: 'claude',
} satisfies SessionRuntimeSpec

/** Mirrors how `AgentRuntime` wires the two app-wide brokers, so settlement
 * events land in the same stream the runtime's own events do — the same shape
 * `AcpSessionRuntime.test.ts` builds for the ACP transport. */
function build(spec: Partial<SessionRuntimeSpec> = {}, timeouts?: Partial<RuntimeTimeouts>) {
  const events: BackendEvent[] = []
  const permissions = new PermissionBroker((settlement) =>
    events.push({
      threadId: settlement.threadId,
      workspaceId: settlement.workspaceId,
      sessionId: settlement.sessionId,
      category: 'permission',
      event: 'permission_resolved',
      data: { requestId: settlement.requestId, outcome: settlement.outcome },
    } as BackendEvent),
  )
  const interactions = new InteractionBroker((settlement) =>
    events.push({
      threadId: settlement.threadId,
      workspaceId: settlement.workspaceId,
      sessionId: settlement.sessionId,
      category: 'extension',
      event: 'extension_resolved',
      data: { requestId: settlement.requestId, method: settlement.method },
    } as BackendEvent),
  )
  const sdk = new FakeClaudeSdk()
  const log = vi.fn()
  const runtime = new ClaudeSessionRuntime(
    { ...SPEC, ...spec },
    {
      config: claude,
      host: { log, onSessionTitle: vi.fn() },
      permissions,
      interactions,
      sdk,
      // The resolver stats a real file, and the runtime must not care which:
      // pointing the override at this test's own node binary exercises the
      // real resolution path without requiring Claude Code to be installed.
      env: { CLAUDE_CODE_BIN: process.execPath },
      ...(timeouts ? { timeouts } : {}),
    },
  )
  const exits: SessionRuntimeExit[] = []
  runtime.onExit((exit) => exits.push(exit))
  runtime.events((event) => events.push(event))
  return { runtime, events, sdk, exits, log, permissions, interactions }
}

const names = (events: BackendEvent[]): string[] => events.map((event) => event.event)
const logged = (log: ReturnType<typeof vi.fn>, fragment: string): boolean =>
  log.mock.calls.some(([entry]) => String(entry?.message ?? '').includes(fragment))

describe('ClaudeSessionRuntime startup', () => {
  it('creates a fresh session under an id it generated itself', async () => {
    const { runtime, events, sdk } = build()
    const result = await runtime.start()

    expect(result.state).toBe('created')
    // Pre-generated and handed to the SDK, never read back off a response, so
    // the caller can persist it before the process even exists.
    expect(sdk.last.options.sessionId).toBe(result.sessionId)
    expect(sdk.last.options.resume).toBeUndefined()
    expect(runtime.sessionId).toBe(result.sessionId)
    expect(runtime.phase).toBe('ready')
    // Exactly this order, exactly once: anything announcing the session before
    // initialization succeeded would persist a resumable id for a launch that
    // failed.
    expect(names(events)).toEqual(['process_spawned', 'initialized', 'session_created'])
  })

  it('resumes a transcript the CLI still has', async () => {
    const { runtime, events, sdk } = build({ sessionId: 'previous-session' })
    sdk.knows('previous-session')
    const result = await runtime.start()

    expect(result).toMatchObject({ sessionId: 'previous-session', state: 'loaded' })
    // Never both: the SDK rejects a query carrying `sessionId` and `resume`.
    expect(sdk.last.options.resume).toBe('previous-session')
    expect(sdk.last.options.sessionId).toBeUndefined()
    expect(names(events)).toEqual(['process_spawned', 'initialized', 'session_loaded'])
  })

  it('falls back to a fresh session when the transcript is genuinely gone', async () => {
    // `getSessionInfo` answers undefined, which is the one resume failure that
    // may be replaced silently — there was nothing to lose.
    const { runtime, events, sdk } = build({ sessionId: 'forgotten-session' })
    const result = await runtime.start()

    expect(result.state).toBe('created')
    expect(result.sessionId).not.toBe('forgotten-session')
    expect(sdk.last.options.resume).toBeUndefined()
    expect(names(events)).toContain('session_created')
    expect(names(events)).not.toContain('session_loaded')
  })

  it('emits nothing about a session that failed to initialize', async () => {
    const { runtime, events, sdk, exits } = build()
    sdk.prepare = (query) => {
      query.initializeError = new Error('Invalid API key')
    }

    await expect(runtime.start()).rejects.toThrow(/Invalid API key/)
    // The whole point of the ordering. A `session_created` here would be
    // persisted as the thread's durable externalId, and every later start
    // would try to resume a transcript Claude never wrote.
    expect(names(events)).not.toContain('session_created')
    expect(names(events)).not.toContain('initialized')
    expect(runtime.phase).toBe('exited')
    expect(exits).toHaveLength(1)
    expect(exits[0]?.reason).toBe('start_failed')
  })

  it('refuses to start when the CLI is not installed', async () => {
    const events: BackendEvent[] = []
    const runtime = new ClaudeSessionRuntime(SPEC, {
      config: claude,
      host: { log: vi.fn(), onSessionTitle: vi.fn() },
      permissions: new PermissionBroker(() => undefined),
      interactions: new InteractionBroker(() => undefined),
      sdk: new FakeClaudeSdk(),
      env: { CLAUDE_CODE_BIN: 'C:/nowhere/claude.exe' },
    })
    runtime.events((event) => events.push(event))

    // An install failure, never `auth_required`: there is nothing to sign in
    // to when the binary is not there.
    await expect(runtime.start()).rejects.toThrow(/CLAUDE_CODE_BIN/)
    expect(names(events)).not.toContain('auth_required')
    expect(names(events)).not.toContain('process_spawned')
  })
})

describe('ClaudeSessionRuntime session id capture', () => {
  it('ignores the transient ids on hook frames', async () => {
    const { runtime, sdk } = build()
    await runtime.start()
    const durable = runtime.sessionId

    for (const subtype of ['hook_started', 'hook_progress', 'hook_response'])
      sdk.last.emitSystem(subtype, 'hook-scoped-id')
    // Give the pump a turn of the loop to have consumed them.
    await Promise.resolve()
    await Promise.resolve()

    // Adopting one of these persists it as the thread's externalId, and the
    // next launch resumes a transcript that never existed.
    expect(runtime.sessionId).toBe(durable)
  })

  it('adopts a durable id the CLI reports on any other frame', async () => {
    const { runtime, sdk } = build()
    await runtime.start()

    sdk.last.emitAssistant('hello', 'reassigned-session')
    await vi.waitFor(() => expect(runtime.sessionId).toBe('reassigned-session'))
  })
})

describe('ClaudeSessionRuntime turns', () => {
  it('binds a turn to the top-level result that ends it', async () => {
    const { runtime, events, sdk } = build()
    await runtime.start()

    let settled = false
    const turn = runtime.prompt({ prompt: { text: 'hi', blocks: [] } }).then(() => {
      settled = true
    })
    await vi.waitFor(() => expect(sdk.last.prompts).toHaveLength(1))

    sdk.last.emitText('hel')
    sdk.last.emitText('lo')
    // A subagent's result terminates its inner loop, not the user's turn.
    sdk.last.emitResult({ parentToolUseId: 'toolu_child' })
    await vi.waitFor(() => expect(names(events)).toContain('agent_message_chunk'))
    expect(settled).toBe(false)

    sdk.last.emitResult()
    await turn
    expect(settled).toBe(true)
    expect(names(events)).toContain('prompt_completed')
    expect(
      events
        .filter((event) => event.event === 'agent_message_chunk')
        .map((event) => (event.data as { content: { text: string } }).content.text),
    ).toEqual(['hel', 'lo'])
  })

  it('runs many turns on one query', async () => {
    const { runtime, sdk } = build()
    await runtime.start()

    for (const text of ['first', 'second']) {
      const turn = runtime.prompt({ prompt: { text, blocks: [] } })
      await vi.waitFor(() => expect(sdk.last.prompts.at(-1)?.message.content).toBe(text))
      sdk.last.emitResult()
      await turn
    }
    // One process, one query, two turns — the whole reason the input stream
    // stays open between prompts.
    expect(sdk.queries).toHaveLength(1)
  })

  it('drops a result that no turn is waiting for', async () => {
    const { runtime, events, sdk, log } = build()
    await runtime.start()

    // A late frame from an already-settled turn. Guessing which turn it
    // belonged to would resolve somebody else's prompt, so it is logged and
    // dropped — and it must not announce a `prompt_completed` either.
    sdk.last.emitResult()
    await vi.waitFor(() => expect(logged(log, 'no turn awaiting it')).toBe(true))
    expect(names(events)).not.toContain('prompt_completed')

    const turn = runtime.prompt({ prompt: { text: 'hi', blocks: [] } })
    let settled = false
    void turn.then(() => {
      settled = true
    })
    await vi.waitFor(() => expect(sdk.last.prompts).toHaveLength(1))
    expect(settled).toBe(false)

    sdk.last.emitResult()
    await turn
    expect(names(events)).toContain('prompt_completed')
  })

  it('does not report the user turn finished when a subagent result lands', async () => {
    const { runtime, events, sdk } = build()
    await runtime.start()

    const turn = runtime.prompt({ prompt: { text: 'hi', blocks: [] } })
    await vi.waitFor(() => expect(sdk.last.prompts).toHaveLength(1))
    sdk.last.emitResult({ parentToolUseId: 'toolu_child' })
    await vi.waitFor(() => expect(sdk.last.prompts).toHaveLength(1))
    expect(names(events)).not.toContain('prompt_completed')

    sdk.last.emitResult()
    await turn
    expect(names(events).filter((name) => name === 'prompt_completed')).toHaveLength(1)
  })

  it('rejects the active turn when the output pump dies', async () => {
    const { runtime, sdk, exits } = build()
    await runtime.start()

    const turn = runtime.prompt({ prompt: { text: 'hi', blocks: [] } })
    await vi.waitFor(() => expect(sdk.last.prompts).toHaveLength(1))
    sdk.last.crash(new Error('CLI died'))

    await expect(turn).rejects.toThrow(/CLI died/)
    // Both, not either: a rejected turn with no exit leaves a dead runtime in
    // the registry, and an exit with a pending turn wedges promptQueues.
    await vi.waitFor(() => expect(exits).toHaveLength(1))
    expect(runtime.phase).toBe('exited')
  })

  it('survives a message type it has never seen', async () => {
    const { runtime, sdk } = build()
    await runtime.start()

    const turn = runtime.prompt({ prompt: { text: 'hi', blocks: [] } })
    await vi.waitFor(() => expect(sdk.last.prompts).toHaveLength(1))
    // The union has 38 members today and grows in point releases; throwing on
    // one would turn a new informational banner into a dead session.
    sdk.last.emitUnknown('some_future_message')
    sdk.last.emitSystem('a_future_subtype', runtime.sessionId ?? '')
    sdk.last.emitResult()

    await turn
    expect(runtime.phase).toBe('ready')
  })
})

describe('ClaudeSessionRuntime cancel', () => {
  it('interrupts and lets the turn settle on its own result', async () => {
    const { runtime, sdk } = build({}, { interruptGraceMs: 5_000 })
    await runtime.start()

    const turn = runtime.prompt({ prompt: { text: 'hi', blocks: [] } })
    await vi.waitFor(() => expect(sdk.last.prompts).toHaveLength(1))
    const cancelled = runtime.cancel()
    await vi.waitFor(() => expect(sdk.last.interrupts).toBe(1))
    sdk.last.emitResult({ stopReason: 'abort' })

    await turn
    await cancelled
    expect(runtime.phase).toBe('ready')
  })

  it('replaces the runtime when the interrupted turn never ends', async () => {
    // The watchdog. Without it a lost result wedges `AgentRuntime.promptQueues`
    // forever, and `SessionReaper` will not rescue it — it skips threads with
    // an active turn, which is exactly what this is.
    const { runtime, sdk, exits } = build({}, { interruptGraceMs: 10 })
    await runtime.start()

    const turn = runtime.prompt({ prompt: { text: 'hi', blocks: [] } })
    void turn.catch(() => undefined)
    await vi.waitFor(() => expect(sdk.last.prompts).toHaveLength(1))

    await runtime.cancel()

    await expect(turn).rejects.toThrow()
    expect(exits).toHaveLength(1)
    expect(exits[0]?.reason).toBe('restart')
    expect(runtime.phase).toBe('exited')
  })
})

describe('ClaudeSessionRuntime exit', () => {
  it('settles once however many paths reach it', async () => {
    const { runtime, events, sdk, exits } = build()
    await runtime.start()

    const [first, second] = await Promise.all([
      runtime.stop({ reason: 'reaped' }),
      runtime.stop({ reason: 'disposed' }),
    ])
    sdk.last.endStream()
    sdk.last.crash(new Error('too late'))
    await runtime.stop({ reason: 'evicted' })

    expect(first).toBe(second)
    // `SessionRuntimeRegistryImpl` removes its entry only from `onExit`, so a
    // second firing would drop a runtime somebody else is still holding.
    expect(exits).toHaveLength(1)
    expect(exits[0]?.reason).toBe('reaped')
    expect(names(events).filter((name) => name === 'process_exited')).toHaveLength(1)
    expect(await runtime.exited).toBe(first)
  })

  it('closes the query and the input stream on the way out', async () => {
    const { runtime, sdk } = build()
    await runtime.start()
    const query = sdk.last

    await runtime.stop({ reason: 'disposed' })

    expect(query.closed).toBe(true)
    // `close()` is fire-and-forget; `return()` is the only handle we have on
    // the SDK's own (bounded) wait for the child to die.
    expect(query.returned).toBe(true)
  })

  it('reports an exit it could not observe as unknown', async () => {
    const { runtime, exits } = build()
    await runtime.start()
    await runtime.stop({ reason: 'disposed' })

    // The SDK surfaces no exit code and no signal. Reporting `exitCode: 0`
    // would make every crash look clean.
    expect(exits[0]).toMatchObject({ exitCode: null, signal: null, forced: false, expected: true })
  })

  it('refuses to restart once it has exited', async () => {
    const { runtime } = build()
    await runtime.start()
    await runtime.stop({ reason: 'reaped' })
    await expect(runtime.start()).rejects.toThrow(/has stopped/)
  })
})

describe('ClaudeSessionRuntime config', () => {
  it('applies model then mode and reports only what landed', async () => {
    const { runtime, events, sdk } = build()
    await runtime.start()

    await runtime.applyDesiredConfig({ modelId: 'opus', modeId: 'plan' })

    expect(sdk.last.models).toEqual(['opus'])
    expect(sdk.last.modes).toEqual(['plan'])
    expect(runtime.applied?.source).toBe('write_through')
    expect(runtime.applied?.options.get('model')?.currentValue).toBe('opus')
    expect(runtime.applied?.options.get('mode')?.currentValue).toBe('plan')
    expect(names(events)).toContain('current_model_update')
    expect(names(events)).toContain('current_mode_update')
  })

  it('skips a write for a value it has already applied', async () => {
    const { runtime, sdk } = build()
    await runtime.start()
    await runtime.applyDesiredConfig({ modelId: 'opus' })
    await runtime.applyDesiredConfig({ modelId: 'opus' })

    expect(sdk.last.models).toEqual(['opus'])
  })

  it('starts warm when the launch already carried the selection', async () => {
    const { runtime, sdk } = build({ desiredConfig: { modelId: 'sonnet', modeId: 'acceptEdits' } })
    await runtime.start()

    // Sent as launch options, not as two control requests after the fact: the
    // first turn can start before a post-hoc setModel would have landed.
    expect(sdk.last.options.model).toBe('sonnet')
    expect(sdk.last.options.permissionMode).toBe('acceptEdits')
    await runtime.applyDesiredConfig({ modelId: 'sonnet', modeId: 'acceptEdits' })
    expect(sdk.last.models).toEqual([])
    expect(sdk.last.modes).toEqual([])
  })

  it('refuses a permission mode Claude Code does not have', async () => {
    const { runtime } = build()
    await runtime.start()
    await expect(runtime.setMode('yolo')).rejects.toThrow(/permission mode/)
  })

  it('throws a typed error behind the capabilities it does not have', async () => {
    const { runtime } = build()
    await runtime.start()

    await expect(runtime.listSessions()).rejects.toMatchObject({
      name: 'CapabilityMissingError',
      capability: 'canListSessions',
    })
    await expect(runtime.setConfigOption('effort', 'high')).rejects.toMatchObject({
      name: 'CapabilityMissingError',
      capability: 'canSetConfigOption',
    })
    expect(runtime.listSessionsAdvertised).toBe(false)
    expect(runtime.resumeCursor).toBeUndefined()
    expect(runtime.respondExtension('anything', {})).toBe(false)
  })
})

describe('ClaudeSessionRuntime rebindThread', () => {
  it('rekeys the brokers so its own settlement still matches', async () => {
    const { runtime, permissions, interactions } = build()
    await runtime.start()
    const permissionRekey = vi.spyOn(permissions, 'rekeyThread')
    const interactionRekey = vi.spyOn(interactions, 'rekeyThread')

    runtime.rebindThread('session-thread', 'workspace-1')

    expect(runtime.threadId).toBe('session-thread')
    // Requests parked under the old id would never be matched by the
    // `settleThread` this runtime issues on exit, and the caller would wait
    // out the broker's five-minute timeout for a process that is gone.
    expect(permissionRekey).toHaveBeenCalledWith(
      'claude',
      'thread-1',
      'session-thread',
      'workspace-1',
    )
    expect(interactionRekey).toHaveBeenCalledWith(
      'claude',
      'thread-1',
      'session-thread',
      'workspace-1',
    )
  })
})
