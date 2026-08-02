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

/** The requestId of the last event of a given name, which is how a test answers
 * an interaction it did not mint the id for. */
const requestIdOf = (events: BackendEvent[], name: string): string => {
  const event = events.filter((candidate) => candidate.event === name).at(-1)
  const requestId = (event?.data as { requestId?: string } | undefined)?.requestId
  if (!requestId) throw new Error(`no ${name} event with a requestId`)
  return requestId
}

describe('ClaudeSessionRuntime permissions', () => {
  it('asks with the SDK-supplied prompt text and allows once', async () => {
    const { runtime, events, sdk } = build()
    await runtime.start()

    const { result } = sdk.last.useTool(
      'Bash',
      { command: 'rm -rf build' },
      { title: 'Claude wants to run rm -rf build', displayName: 'Run command' },
    )
    await vi.waitFor(() => expect(names(events)).toContain('permission_request'))
    const request = events.find((event) => event.event === 'permission_request')?.data as {
      requestId: string
      toolCall: { title: string; kind: string; toolCallId: string }
      metadata?: Record<string, unknown>
      options: { optionId: string }[]
    }
    // `title` is the bridge's own sentence and `displayName` the compact label;
    // reconstructing either from toolName+input would drift from the CLI's
    // wording and be plain wrong for MCP tools.
    expect(request.metadata?.title).toBe('Claude wants to run rm -rf build')
    expect(request.toolCall.title).toBe('Run command')
    expect(request.toolCall.kind).toBe('execute')
    expect(request.toolCall.toolCallId).toBe('toolu_Bash')
    expect(request.options.map((option) => option.optionId)).toEqual([
      'allow_once',
      'allow_always',
      'reject_once',
    ])

    expect(runtime.respondPermission(request.requestId, { outcome: 'selected', optionId: 'allow_once' })).toBe(true)
    // No `updatedInput`: the input is unchanged and the SDK reads an omitted
    // one as "run what you asked to run".
    expect(await result).toEqual({ behavior: 'allow' })
  })

  it('carries the SDK\'s own suggestions on always-allow, and never synthesizes any', async () => {
    const suggestions = [
      { type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' },
    ]
    const { runtime, events, sdk } = build()
    await runtime.start()

    const withSuggestions = sdk.last.useTool('Bash', { command: 'ls' }, { suggestions })
    await vi.waitFor(() => expect(names(events)).toContain('permission_request'))
    runtime.respondPermission(requestIdOf(events, 'permission_request'), {
      outcome: 'selected',
      optionId: 'allow_always',
    })
    expect(await withSuggestions.result).toEqual({ behavior: 'allow', updatedPermissions: suggestions })

    const withoutSuggestions = sdk.last.useTool('Read', { file_path: 'C:/a.ts' })
    await vi.waitFor(
      () => expect(names(events).filter((name) => name === 'permission_request')).toHaveLength(2),
    )
    runtime.respondPermission(requestIdOf(events, 'permission_request'), {
      outcome: 'selected',
      optionId: 'allow_always',
    })
    // Inventing a rule would write a permission into the user's settings that
    // the CLI never proposed.
    expect(await withoutSuggestions.result).toEqual({ behavior: 'allow' })
  })

  it('denies on rejection and on cancellation alike', async () => {
    const { runtime, events, sdk } = build()
    await runtime.start()

    const rejected = sdk.last.useTool('Bash', { command: 'ls' })
    await vi.waitFor(() => expect(names(events)).toContain('permission_request'))
    runtime.respondPermission(requestIdOf(events, 'permission_request'), {
      outcome: 'selected',
      optionId: 'reject_once',
    })
    expect(await rejected.result).toMatchObject({ behavior: 'deny' })

    const cancelled = sdk.last.useTool('Bash', { command: 'ls' })
    await vi.waitFor(
      () => expect(names(events).filter((name) => name === 'permission_request')).toHaveLength(2),
    )
    runtime.respondPermission(requestIdOf(events, 'permission_request'), {
      outcome: 'cancelled',
      reason: 'user',
    })
    expect(await cancelled.result).toEqual({
      behavior: 'deny',
      message: 'User cancelled tool execution.',
    })
  })

  it('settles a parked request when the callback aborts', async () => {
    const { runtime, events, sdk } = build()
    await runtime.start()

    const { result, controller } = sdk.last.useTool('Bash', { command: 'ls' })
    await vi.waitFor(() => expect(names(events)).toContain('permission_request'))
    controller.abort()

    // A callback abandoned by the SDK must not sit until the five-minute
    // timeout holding the tool — and the abort and a late user answer settle
    // through the same one-shot broker record.
    expect(await result).toMatchObject({ behavior: 'deny' })
    expect(
      runtime.respondPermission(requestIdOf(events, 'permission_request'), {
        outcome: 'selected',
        optionId: 'allow_once',
      }),
    ).toBe(false)
  })

  it('settles everything parked when the runtime goes away', async () => {
    const { runtime, events, sdk } = build()
    await runtime.start()

    const permission = sdk.last.useTool('Bash', { command: 'ls' })
    const question = sdk.last.useTool('AskUserQuestion', {
      questions: [
        { question: 'Which?', header: 'Pick', multiSelect: false, options: [{ label: 'a', description: '' }] },
      ],
    })
    await vi.waitFor(() => expect(names(events)).toContain('question_request'))

    runtime.dispose()

    // A pending callback outliving its process is what wedges a turn forever.
    expect(await permission.result).toMatchObject({ behavior: 'deny' })
    expect(await question.result).toMatchObject({ behavior: 'deny' })
  })

  it('does not ask at all under a full-access mode', async () => {
    const { runtime, events, sdk } = build({ desiredConfig: { modeId: 'bypassPermissions' } })
    await runtime.start()

    expect(await sdk.last.useTool('Bash', { command: 'ls' }).result).toEqual({ behavior: 'allow' })
    expect(names(events)).not.toContain('permission_request')
  })
})

describe('ClaudeSessionRuntime questions', () => {
  const askInput = (questions: unknown[]) => ({ questions })
  const oneQuestion = (text: string, labels: string[], multiSelect = false) => ({
    question: text,
    header: 'Pick',
    multiSelect,
    options: labels.map((label) => ({ label, description: '' })),
  })

  it('answers back into the tool input, keyed by the original question text', async () => {
    const { runtime, events, sdk } = build()
    await runtime.start()

    const input = askInput([oneQuestion('Which library?', ['zod', 'valibot'])])
    const { result } = sdk.last.useTool('AskUserQuestion', input)
    await vi.waitFor(() => expect(names(events)).toContain('question_request'))
    const request = events.find((event) => event.event === 'question_request')?.data as {
      requestId: string
      questions: { questionId: string }[]
    }
    // The UI id is synthetic; the SDK's key is the question text.
    expect(request.questions[0]?.questionId).toBe(`${request.requestId}:0`)

    expect(
      runtime.respondQuestion(request.requestId, {
        outcome: 'answered',
        answers: [{ questionId: `${request.requestId}:0`, selectedOptionIds: ['o1'] }],
      }),
    ).toBe(true)
    // REPLACED wholesale, not spread: `{questions, answers}` is the shape the
    // tool's output schema describes.
    expect(await result).toEqual({
      behavior: 'allow',
      updatedInput: { questions: input.questions, answers: { 'Which library?': 'valibot' } },
    })
  })

  it('keeps duplicate question texts apart in the UI and merged on the wire', async () => {
    const { runtime, events, sdk } = build()
    await runtime.start()

    const { result } = sdk.last.useTool(
      'AskUserQuestion',
      askInput([oneQuestion('Same?', ['a', 'b']), oneQuestion('Same?', ['c', 'd'])]),
    )
    await vi.waitFor(() => expect(names(events)).toContain('question_request'))
    const request = events.find((event) => event.event === 'question_request')?.data as {
      requestId: string
      questions: { questionId: string }[]
    }
    // Distinct ids, or the composer's rows and selections would overwrite each
    // other before an answer was ever sent.
    expect(request.questions.map((question) => question.questionId)).toEqual([
      `${request.requestId}:0`,
      `${request.requestId}:1`,
    ])

    runtime.respondQuestion(request.requestId, {
      outcome: 'answered',
      answers: [
        { questionId: `${request.requestId}:0`, selectedOptionIds: ['o0'] },
        { questionId: `${request.requestId}:1`, selectedOptionIds: ['o1'] },
      ],
    })
    expect((await result as { updatedInput: { answers: unknown } }).updatedInput.answers).toEqual({
      'Same?': 'a, d',
    })
  })

  it('denies when the user dismisses the question', async () => {
    const { runtime, events, sdk } = build()
    await runtime.start()

    const { result } = sdk.last.useTool('AskUserQuestion', askInput([oneQuestion('A?', ['x'])]))
    await vi.waitFor(() => expect(names(events)).toContain('question_request'))
    runtime.respondQuestion(requestIdOf(events, 'question_request'), {
      outcome: 'cancelled',
      reason: 'user',
    })

    expect(await result).toEqual({
      behavior: 'deny',
      message: 'User cancelled tool execution.',
    })
  })

  it('asks even under a full-access mode', async () => {
    // `bypassPermissions` and `dontAsk` are statements about permission, not
    // about whether the user wants to be talked to.
    const { runtime, events, sdk } = build({ desiredConfig: { modeId: 'dontAsk' } })
    await runtime.start()

    sdk.last.useTool('AskUserQuestion', askInput([oneQuestion('A?', ['x'])]))
    await vi.waitFor(() => expect(names(events)).toContain('question_request'))
  })

  it('refuses to answer a request that is not a question', async () => {
    const { runtime, events, sdk } = build()
    await runtime.start()
    sdk.last.useTool('ExitPlanMode', { plan: '# Plan' })
    await vi.waitFor(() => expect(names(events)).toContain('plan_review_request'))

    // Request ids are globally unique across kinds; answering a plan as a
    // question would settle it with a payload the plan branch cannot read.
    expect(
      runtime.respondQuestion(requestIdOf(events, 'plan_review_request'), {
        outcome: 'cancelled',
      }),
    ).toBe(false)
  })
})

describe('ClaudeSessionRuntime plan review', () => {
  it('releases the same turn on approval', async () => {
    const { runtime, events, sdk } = build()
    await runtime.start()

    const { result } = sdk.last.useTool('ExitPlanMode', {
      plan: '# Do the thing\n\nFirst pass.\n\n- [ ] Step one',
    })
    await vi.waitFor(() => expect(names(events)).toContain('plan_review_request'))
    const request = events.find((event) => event.event === 'plan_review_request')?.data as {
      requestId: string
      continuation: string
      todos: unknown[]
      name?: string
    }
    // The field that stops `build_plan` dispatching a second turn and running
    // the whole plan — every edit, every command — twice.
    expect(request.continuation).toBe('same_turn')
    expect(request.name).toBe('Do the thing')
    expect(request.todos).toHaveLength(1)

    expect(runtime.respondPlan(request.requestId, { outcome: 'accepted' })).toBe(true)
    expect(await result).toEqual({ behavior: 'allow' })
  })

  it('denies with the reviewer\'s reason on rejection', async () => {
    const { runtime, events, sdk } = build()
    await runtime.start()

    const { result } = sdk.last.useTool('ExitPlanMode', { plan: '# Plan' })
    await vi.waitFor(() => expect(names(events)).toContain('plan_review_request'))
    runtime.respondPlan(requestIdOf(events, 'plan_review_request'), {
      outcome: 'rejected',
      reason: 'Do the migration first',
    })

    expect(await result).toEqual({ behavior: 'deny', message: 'Do the migration first' })
  })

  it('reuses the first decision for a repeated callback on the same tool call', async () => {
    const { runtime, events, sdk } = build()
    await runtime.start()

    const first = sdk.last.useTool('ExitPlanMode', { plan: '# Plan' })
    await vi.waitFor(() => expect(names(events)).toContain('plan_review_request'))
    runtime.respondPlan(requestIdOf(events, 'plan_review_request'), { outcome: 'accepted' })
    await first.result

    // A retried turn re-invokes the callback for the same toolUseID; asking
    // again would either confuse the user or re-run an approved plan.
    expect(await sdk.last.useTool('ExitPlanMode', { plan: '# Plan' }).result).toEqual({
      behavior: 'allow',
    })
    expect(names(events).filter((name) => name === 'plan_review_request')).toHaveLength(1)
  })
})

describe('ClaudeSessionRuntime usage', () => {
  it('reports turn tokens and context occupancy as two different things', async () => {
    const { runtime, events, sdk } = build()
    await runtime.start()

    const turn = runtime.prompt({ prompt: { text: 'hi', blocks: [] } })
    await vi.waitFor(() => expect(sdk.last.prompts).toHaveLength(1))
    sdk.last.emitMessageDelta({ input_tokens: 100, output_tokens: 20 })
    sdk.last.emitResult()
    await turn

    // `prompt_completed.usage` is `TokenUsage` — what the turn cost.
    const completed = events.find((event) => event.event === 'prompt_completed')?.data as {
      usage?: { inputTokens: number; outputTokens: number }
    }
    expect(completed.usage).toMatchObject({ inputTokens: 100, outputTokens: 20 })

    // `usage_update` is `SessionUsage` — how full the window is — and its only
    // correct source is the control request that carries both halves.
    await vi.waitFor(() => expect(names(events)).toContain('usage_update'))
    expect(events.find((event) => event.event === 'usage_update')?.data).toEqual({
      used: 12_000,
      size: 200_000,
    })
    expect(sdk.last.contextUsageCalls).toBe(1)
  })

  it('still settles the turn when the context read fails', async () => {
    const { runtime, events, sdk } = build()
    await runtime.start()
    sdk.last.contextUsageError = new Error('control request not supported')

    const turn = runtime.prompt({ prompt: { text: 'hi', blocks: [] } })
    await vi.waitFor(() => expect(sdk.last.prompts).toHaveLength(1))
    sdk.last.emitResult()

    // A cosmetic meter must never delay or fail a turn's settlement.
    await turn
    expect(names(events)).toContain('prompt_completed')
    expect(names(events)).not.toContain('usage_update')
  })
})

describe('ClaudeSessionRuntime prompt content', () => {
  it('sends an image attachment as a base64 content block', async () => {
    const { runtime, sdk } = build()
    await runtime.start()

    const turn = runtime.prompt({
      prompt: {
        text: 'what is this',
        blocks: [
          { type: 'text', text: 'what is this' },
          { type: 'image', mimeType: 'image/png', data: 'AAAA' },
        ],
      },
    })
    await vi.waitFor(() => expect(sdk.last.prompts).toHaveLength(1))
    expect(sdk.last.prompts[0]?.message.content).toEqual([
      { type: 'text', text: 'what is this' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    ])
    sdk.last.emitResult()
    await turn
  })

  it('advertises image support so the composer allows attachments', async () => {
    const { runtime, events } = build()
    await runtime.start()

    expect(
      (events.find((event) => event.event === 'initialized')?.data as {
        promptCapabilities?: { image?: boolean }
      }).promptCapabilities,
    ).toMatchObject({ image: true })
  })

  it('refuses unsupported content before a turn is ever opened', async () => {
    const { runtime, events, sdk } = build()
    await runtime.start()

    await expect(
      runtime.prompt({
        prompt: { text: '', blocks: [{ type: 'audio', mimeType: 'audio/wav', data: 'AAAA' }] },
      }),
    ).rejects.toThrow(/audio/)
    // Nothing dispatched and nothing announced: a started turn that never runs
    // is worse than a visible, attributable failure.
    expect(sdk.last.prompts).toHaveLength(0)
    expect(names(events)).not.toContain('prompt_started')
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
