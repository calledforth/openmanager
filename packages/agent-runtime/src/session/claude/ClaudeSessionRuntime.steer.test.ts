import { describe, expect, it, vi } from 'vitest'
import type { BackendEvent } from '../../backends/Backend.js'
import { InteractionBroker } from '../../core/InteractionBroker.js'
import { PermissionBroker } from '../../core/PermissionBroker.js'
import { claude } from '../../providers/claude.js'
import { ClaudeSessionRuntime } from './ClaudeSessionRuntime.js'
import { FakeClaudeSdk, type FakeClaudeQuery } from './test-sdk.js'

/**
 * Steering, as the CLI does it (probed on Agent SDK 0.3.220 and 0.3.323): an
 * async user message is queued (`command_lifecycle: queued`). With
 * `priority: 'now'`, sent while the agent writes, the CLI cuts the reply off
 * and `started`s the message as a turn of its own a few ms after that turn's
 * result. With `'next'`, sent while a tool runs, it is `started` inside the
 * turn once the tool returns (the fold). Until then `cancel_async_message`
 * can drop it (`cancelled`).
 */
function build() {
  const events: BackendEvent[] = []
  const sdk = new FakeClaudeSdk()
  const runtime = new ClaudeSessionRuntime(
    { threadId: 'thread-1', workspaceId: 'workspace-1', cwd: 'C:/workspace', providerId: 'claude' },
    {
      config: claude,
      host: { log: vi.fn(), onSessionTitle: vi.fn() },
      permissions: new PermissionBroker(() => undefined),
      interactions: new InteractionBroker(() => undefined),
      sdk,
      env: { CLAUDE_CODE_BIN: process.execPath },
    },
  )
  runtime.events((event) => events.push(event))
  return { runtime, events, sdk }
}

const steerEvents = (events: BackendEvent[]) =>
  events
    .filter((event) => event.event.startsWith('steer_'))
    .map((event) => [event.event, (event.data as { steerId: string }).steerId])

/** Start a turn on a CLI that reports message lifecycles, the way 2.1.x does. */
async function runningTurn(capabilities = ['interrupt_receipt_v1', 'msg_lifecycle_v1']) {
  const built = build()
  await built.runtime.start()
  const turn = built.runtime.prompt({ prompt: { text: 'Run the tests', blocks: [] } })
  await vi.waitFor(() => expect(built.sdk.last.prompts).toHaveLength(1))
  built.sdk.last.emitSystem('init', built.sdk.last.sessionId, { capabilities })
  // The frame reaches the runtime through its output pump, a few ticks on.
  await new Promise((resolve) => setTimeout(resolve, 10))
  return { ...built, turn, first: built.sdk.last.prompts[0]!.uuid! }
}

/** Steer, and have the fake CLI hold the message as the real one queues it. */
async function steer(runtime: ClaudeSessionRuntime, query: FakeClaudeQuery, text: string) {
  const before = query.prompts.length
  await runtime.steer({ prompt: { text, blocks: [] }, steerId: `steer:${text}` })
  await vi.waitFor(() => expect(query.prompts.length).toBe(before + 1))
  const sent = query.prompts.at(-1)!
  query.heldCommands.add(sent.uuid!)
  query.emitLifecycle(sent.uuid!, 'queued')
  return sent
}

describe('ClaudeSessionRuntime steering', () => {
  it('sends a steer as a now-priority message that starts a turn of its own', async () => {
    const { runtime, events, sdk, turn, first } = await runningTurn()
    sdk.last.emitText('Writing a long reply')
    const sent = await steer(runtime, sdk.last, 'Skip the slow ones')
    expect(sent.priority).toBe('now')
    expect(sent.message.content).toEqual('Skip the slow ones')
    expect(steerEvents(events)).toEqual([])

    // The CLI cuts the reply off and dequeues the steer for its own turn
    // before anything could take it back.
    sdk.last.heldCommands.delete(sent.uuid!)
    sdk.last.emitResult({ userMessageUuid: first, terminalReason: 'aborted_streaming' })
    await turn
    sdk.last.emitLifecycle(sent.uuid!, 'started')
    await vi.waitFor(() =>
      expect(steerEvents(events)).toEqual([['steer_turn_started', 'steer:Skip the slow ones']]),
    )
    expect(runtime.busy).toBe(true)
    sdk.last.emitText('Skipping them.')
    sdk.last.emitResult({ userMessageUuid: sent.uuid! })
    await vi.waitFor(() => expect(runtime.busy).toBe(false))
    expect(events.filter((event) => event.event === 'prompt_completed')).toHaveLength(2)
  })

  it('reports a fold when the CLI takes a steer inside the turn after all', async () => {
    const { runtime, events, sdk, turn, first } = await runningTurn()
    const sent = await steer(runtime, sdk.last, 'Fold me')
    sdk.last.emitLifecycle(sent.uuid!, 'started')
    await vi.waitFor(() =>
      expect(steerEvents(events)).toEqual([['steer_delivered', 'steer:Fold me']]),
    )
    sdk.last.emitResult({ userMessageUuid: first })
    await turn
    expect(sdk.last.cancelledCommands).toEqual([])
  })

  it('waits for a running tool with next, and cuts a reply off with now', async () => {
    const { runtime, sdk } = await runningTurn()
    sdk.last.emitAssistantBlocks([
      { type: 'tool_use', id: 'toolu_bash', name: 'Bash', input: { command: 'pnpm test' } },
    ])
    await new Promise((resolve) => setTimeout(resolve, 10))
    const during = await steer(runtime, sdk.last, 'After the tests')
    // A held `now` would make the CLI ignore Stop until the command ends.
    expect(during.priority).toBe('next')

    sdk.last.emitToolResult('toolu_bash', 'ok')
    sdk.last.emitText('All green, and now')
    await new Promise((resolve) => setTimeout(resolve, 10))
    const writing = await steer(runtime, sdk.last, 'Shorter please')
    expect(writing.priority).toBe('now')
  })

  it('moves foreground subagents to the background before it steers', async () => {
    const { runtime, sdk } = await runningTurn()
    sdk.last.emitAssistantBlocks([
      { type: 'tool_use', id: 'toolu_agent', name: 'Agent', input: { prompt: 'Run the suite' } },
      {
        type: 'tool_use',
        id: 'toolu_bg_agent',
        name: 'Agent',
        input: { prompt: 'Watch', run_in_background: true },
      },
    ])
    // The background one returns at once.
    sdk.last.emitToolResult('toolu_bg_agent', 'Async agent launched successfully.')
    // A subagent's own subagent is its business, not the main agent's.
    sdk.last.emitAssistantBlocks(
      [{ type: 'tool_use', id: 'toolu_nested', name: 'Agent', input: { prompt: 'x' } }],
      'toolu_agent',
    )
    await new Promise((resolve) => setTimeout(resolve, 10))
    let release!: () => void
    sdk.last.backgroundGate = new Promise((resolve) => (release = resolve))
    const steering = runtime.steer({ prompt: { text: 'Stop that', blocks: [] }, steerId: 's' })
    await vi.waitFor(() => expect(sdk.last.backgroundedTools).toEqual(['toolu_agent']))
    // Nothing goes to the CLI until the subagent is safe.
    expect(sdk.last.prompts).toHaveLength(1)
    release()
    await steering
    // Moved, nothing holds the message: it cuts in.
    await vi.waitFor(() => expect(sdk.last.prompts.at(-1)?.priority).toBe('now'))

    // Its call returned ("running in the background"): a second steer has
    // nothing to move.
    await new Promise((resolve) => setTimeout(resolve, 10))
    await runtime.steer({ prompt: { text: 'And this', blocks: [] }, steerId: 's2' })
    expect(sdk.last.backgroundedTools).toEqual(['toolu_agent'])
  })

  it('refuses a steer whose turn ended while subagents were being moved', async () => {
    const { runtime, sdk, turn, first } = await runningTurn()
    sdk.last.emitAssistantBlocks([
      { type: 'tool_use', id: 'toolu_agent', name: 'Agent', input: { prompt: 'Run' } },
    ])
    await new Promise((resolve) => setTimeout(resolve, 10))
    let release!: () => void
    sdk.last.backgroundGate = new Promise((resolve) => (release = resolve))
    const steering = runtime.steer({ prompt: { text: 'Late', blocks: [] }, steerId: 's' })
    await vi.waitFor(() => expect(sdk.last.backgroundedTools).toHaveLength(1))
    sdk.last.emitResult({ userMessageUuid: first })
    await turn
    release()
    await expect(steering).rejects.toThrow(/ended before the steer was sent/)
    expect(sdk.last.prompts).toHaveLength(1)
  })

  it('takes one steer back on request, and only while the CLI holds it', async () => {
    const { runtime, events, sdk } = await runningTurn()
    const kept = await steer(runtime, sdk.last, 'Keep')
    const sent = await steer(runtime, sdk.last, 'Send now')
    await expect(runtime.withdrawSteer('steer:Send now')).resolves.toBe(true)
    expect(sdk.last.cancelledCommands).toEqual([sent.uuid])
    expect(steerEvents(events)).toEqual([['steer_withdrawn', 'steer:Send now']])

    // Already dequeued: it runs, so it is not the caller's to resend.
    sdk.last.heldCommands.delete(kept.uuid!)
    await expect(runtime.withdrawSteer('steer:Keep')).resolves.toBe(false)
    await expect(runtime.withdrawSteer('steer:unknown')).resolves.toBe(false)
    expect(steerEvents(events)).toEqual([['steer_withdrawn', 'steer:Send now']])
  })

  it('refuses a steer when no turn runs, and when the CLI cannot report lifecycles', async () => {
    const idle = build()
    await idle.runtime.start()
    await expect(
      idle.runtime.steer({ prompt: { text: 'x', blocks: [] }, steerId: 's' }),
    ).rejects.toThrow(/no turn to steer/)

    const { runtime, sdk } = await runningTurn(['interrupt_receipt_v1'])
    await expect(
      runtime.steer({ prompt: { text: 'x', blocks: [] }, steerId: 's' }),
    ).rejects.toThrow(/cannot report/)
    expect(sdk.last.prompts).toHaveLength(1)
  })

  it('takes back a steer the turn ended without reading', async () => {
    const { runtime, events, sdk, turn, first } = await runningTurn()
    const sent = await steer(runtime, sdk.last, 'Also lint')
    sdk.last.emitResult({ userMessageUuid: first })
    await turn
    await vi.waitFor(() =>
      expect(steerEvents(events)).toEqual([['steer_withdrawn', 'steer:Also lint']]),
    )
    expect(sdk.last.cancelledCommands).toEqual([sent.uuid])
    expect(runtime.busy).toBe(false)
  })

  it('opens the turn the CLI starts for a steer that missed its turn', async () => {
    const { runtime, events, sdk, turn, first } = await runningTurn()
    const sent = await steer(runtime, sdk.last, 'Say LATE')
    // The CLI dequeued it for its next turn before the cancel arrived.
    sdk.last.heldCommands.delete(sent.uuid!)
    sdk.last.emitResult({ userMessageUuid: first })
    await turn
    sdk.last.emitLifecycle(sent.uuid!, 'started')
    await vi.waitFor(() =>
      expect(steerEvents(events)).toEqual([['steer_turn_started', 'steer:Say LATE']]),
    )
    expect(runtime.busy).toBe(true)
    sdk.last.emitText('LATE')
    sdk.last.emitResult({ userMessageUuid: sent.uuid! })
    await vi.waitFor(() => expect(runtime.busy).toBe(false))
    const completions = events.filter((event) => event.event === 'prompt_completed')
    expect(completions).toHaveLength(2)
  })

  it('takes steers back before it interrupts, so Stop runs nothing later', async () => {
    const { runtime, events, sdk, turn } = await runningTurn()
    const sent = await steer(runtime, sdk.last, 'Never mind')
    const stopping = runtime.cancel()
    await vi.waitFor(() => expect(sdk.last.interrupts).toBe(1))
    expect(sdk.last.cancelledCommands).toEqual([sent.uuid])
    expect(steerEvents(events)).toEqual([['steer_withdrawn', 'steer:Never mind']])
    sdk.last.emitResult({ subtype: 'error_during_execution', terminalReason: 'aborted_tools' })
    await stopping
    await turn.catch(() => undefined)
  })

  it('takes back one more time what survived the interrupt', async () => {
    const { runtime, events, sdk, turn } = await runningTurn()
    const sent = await steer(runtime, sdk.last, 'Mid-fold')
    // Mid-fold at the first pass: the CLI would not drop it yet.
    sdk.last.heldCommands.delete(sent.uuid!)
    sdk.last.stillQueued = [sent.uuid!]
    const original = sdk.last.interrupt.bind(sdk.last)
    sdk.last.interrupt = async () => {
      const receipt = await original()
      sdk.last.heldCommands.add(sent.uuid!)
      return receipt
    }
    const stopping = runtime.cancel()
    await vi.waitFor(() =>
      expect(steerEvents(events)).toEqual([['steer_withdrawn', 'steer:Mid-fold']]),
    )
    expect(sdk.last.cancelledCommands).toEqual([sent.uuid, sent.uuid])
    sdk.last.emitResult({ subtype: 'error_during_execution', terminalReason: 'aborted_tools' })
    await stopping
    await turn.catch(() => undefined)
  })

  it('holds a prompt back while a steer is still with the CLI', async () => {
    const { runtime, sdk, turn, first } = await runningTurn()
    const sent = await steer(runtime, sdk.last, 'Late')
    sdk.last.heldCommands.delete(sent.uuid!)
    sdk.last.emitResult({ userMessageUuid: first })
    await turn
    await expect(runtime.prompt({ prompt: { text: 'Next', blocks: [] } })).rejects.toThrow(
      /still holds a steered message/,
    )
  })

  it('replaces a CLI that cannot give a steer back, which gives it back', async () => {
    const { runtime, events, sdk, turn } = await runningTurn()
    await steer(runtime, sdk.last, 'Stuck')
    sdk.last.cancelAsyncMessage = async () => {
      throw new Error('wedged')
    }
    await runtime.cancel().catch(() => undefined)
    await turn.catch(() => undefined)
    await vi.waitFor(() =>
      expect(steerEvents(events)).toEqual([['steer_withdrawn', 'steer:Stuck']]),
    )
    expect(runtime.phase).toBe('exited')
  })

  it('gives every held steer back when the process dies', async () => {
    const { runtime, events, sdk, turn } = await runningTurn()
    await steer(runtime, sdk.last, 'One')
    await steer(runtime, sdk.last, 'Two')
    sdk.last.crash(new Error('boom'))
    await turn.catch(() => undefined)
    await vi.waitFor(() =>
      expect(steerEvents(events)).toEqual([
        ['steer_withdrawn', 'steer:One'],
        ['steer_withdrawn', 'steer:Two'],
      ]),
    )
  })
})
