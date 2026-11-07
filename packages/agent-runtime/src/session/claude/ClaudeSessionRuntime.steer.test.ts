import { describe, expect, it, vi } from 'vitest'
import type { BackendEvent } from '../../backends/Backend.js'
import { InteractionBroker } from '../../core/InteractionBroker.js'
import { PermissionBroker } from '../../core/PermissionBroker.js'
import { claude } from '../../providers/claude.js'
import { ClaudeSessionRuntime } from './ClaudeSessionRuntime.js'
import { FakeClaudeSdk, type FakeClaudeQuery } from './test-sdk.js'

/**
 * Steering, as the CLI does it (probed on Agent SDK 0.3.220): an async user
 * message with `priority: 'next'` is queued (`command_lifecycle: queued`),
 * then `started` at the running turn's next tool boundary, where it folds into
 * that turn. A message still queued when the turn ends is started as a turn of
 * its own, or dropped by `cancel_async_message` (`cancelled`).
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
  it('sends a steer as a next-priority message and reports the fold', async () => {
    const { runtime, events, sdk, turn, first } = await runningTurn()
    const sent = await steer(runtime, sdk.last, 'Skip the slow ones')
    expect(sent.priority).toBe('next')
    expect(sent.message.content).toEqual('Skip the slow ones')
    expect(steerEvents(events)).toEqual([])

    // The next tool boundary: the CLI takes it into the running turn.
    sdk.last.emitLifecycle(sent.uuid!, 'started')
    await vi.waitFor(() =>
      expect(steerEvents(events)).toEqual([['steer_delivered', 'steer:Skip the slow ones']]),
    )
    sdk.last.emitText('Skipping them.')
    sdk.last.emitResult({ userMessageUuid: first })
    await turn
    // One turn, one result: nothing was withdrawn, nothing ran on its own.
    expect(steerEvents(events)).toEqual([['steer_delivered', 'steer:Skip the slow ones']])
    expect(sdk.last.cancelledCommands).toEqual([])
    expect(runtime.busy).toBe(false)
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
