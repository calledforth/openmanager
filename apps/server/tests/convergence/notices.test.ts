/**
 * Notices and failures (F7). A durable notice is an event and a row, a failure
 * stays with its turn, and a live notice lasts until the server says it is
 * over. Every scenario asserts rule 6; live notices are outside the comparison
 * (§8.1), so those about them read the client and the wire directly.
 */
import { describe, expect } from 'vitest'
import { resendablePrompt } from '@openmanager/environment-client'
import { expectConverges } from './evidence.ts'
import { until, type Rig, type TestClient } from './harness.ts'
import type { FrameRecord } from './link-proxy.ts'
import { scenario } from './scenario.ts'
import { createSession, startTurn, thread, untilThread, type Target } from './steps.ts'

const CLAUDE = { providerId: 'claude', quiet: true } as const

const words = (value: string) => ({
  type: 'stream_event',
  event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: value } },
})
const retry = (attempt: number) => ({
  type: 'system',
  subtype: 'api_retry',
  attempt,
  max_retries: 10,
  retry_delay_ms: 1000,
  error_status: 529,
  error: 'overloaded',
})
const compacting = { type: 'system', subtype: 'status', status: 'compacting' }
const compacted = {
  type: 'system',
  subtype: 'compact_boundary',
  compact_metadata: { trigger: 'auto', pre_tokens: 180_000, post_tokens: 40_000 },
}
const fallback = {
  type: 'system',
  subtype: 'model_refusal_fallback',
  original_model: 'claude-opus',
  fallback_model: 'claude-sonnet',
  api_refusal_explanation: 'This model will not do that.',
}
const usageWarning = (resetsAt: number) => ({
  type: 'rate_limit_event',
  rate_limit_info: {
    status: 'allowed_warning',
    rateLimitType: 'five_hour',
    surpassedThreshold: 0.9,
    resetsAt,
  },
})

/** A running Claude turn whose prompt has reached the provider. */
async function claudeTurn(rig: Rig, client: TestClient, promptNumber = 1, existing?: Target) {
  const target = existing ?? (await createSession(rig, client, CLAUDE))
  const turnId = await startTurn(client, target, `Prompt ${promptNumber}`)
  await rig.provider({ op: 'claudeWaitPrompt', prompts: promptNumber })
  return { target, turnId }
}

const emit = (rig: Rig, ...messages: Record<string, unknown>[]) =>
  rig.provider({ op: 'claudeEmit', messages })

const tooLong = {
  subtype: 'error_during_execution' as const,
  errors: ['Prompt is too long'],
  terminalReason: 'prompt_too_long',
}

const noticeKinds = (client: TestClient, target: Target) =>
  thread(client, target)?.notices.map((notice) => notice.kind)
const orderKinds = (client: TestClient, target: Target) =>
  thread(client, target)?.order.map((ref) => ref.kind)
const live = (client: TestClient, target: Target) =>
  thread(client, target)?.liveNotices.map((notice) => notice.kind) ?? []

const transientNames = (frames: readonly FrameRecord[]) =>
  frames.flatMap((frame) => {
    if (frame.direction !== 'down') return []
    const name = (frame.json as { name?: unknown } | undefined)?.name
    if (name !== 'subscription.transient') return []
    const event = (frame.json as { payload: { event: { name: string } } }).payload.event
    return [event.name]
  })

describe('notices and failures', () => {
  scenario('N1 durable notices written while away are replayed in place', {}, async (rig) => {
    const a = await rig.connect('A')
    const { target } = await claudeTurn(rig, a)
    await emit(rig, words('Before'), compacted)
    await untilThread(a, target, (state) => state.notices.length === 1, 'A to hold the notice')
    rig.proxy.down()
    rig.proxy.cut()
    await emit(rig, words('During'), fallback, usageWarning(1_800_000_000))
    await rig.waitQuiet()
    rig.proxy.up()
    await untilThread(a, target, (state) => state.notices.length === 3, 'the replay')
    expect(noticeKinds(a, target)).toEqual(['compacted', 'model_fallback', 'usage_warning'])
    expect(orderKinds(a, target)).toEqual([
      'message',
      'message',
      'notice',
      'message',
      'notice',
      'notice',
    ])
    await expectConverges('N1', rig, a)
  })

  scenario('N2 a typed failure reaches a client that was away', {}, async (rig) => {
    const a = await rig.connect('A')
    const { target, turnId } = await claudeTurn(rig, a)
    rig.proxy.down()
    rig.proxy.cut()
    await rig.provider({ op: 'claudeComplete', failure: tooLong })
    await rig.waitQuiet()
    rig.proxy.up()
    await until(
      () => thread(a, target)?.turns.find((turn) => turn.turnId === turnId)?.failure,
      'the replay to bring the failure',
    )
    expect(thread(a, target)?.turns.at(-1)?.failure).toEqual({
      reason: 'context_window_exceeded',
      message: "The conversation is too long for the model's context window.",
      action: 'compact',
      detail: 'Prompt is too long',
    })
    await expectConverges('N2', rig, a)
  })

  scenario('N3 past retention, a snapshot says the same', {}, async (rig) => {
    const a = await rig.connect('A')
    const { target } = await claudeTurn(rig, a)
    await emit(rig, words('Before'))
    await untilThread(a, target, (state) => state.messages.length === 2, 'A to hold the text')
    rig.proxy.down()
    rig.proxy.cut()
    await emit(rig, compacted, words('After'))
    await rig.provider({ op: 'claudeComplete', failure: tooLong })
    await rig.waitQuiet()
    await rig.server.call({ op: 'raiseReplayFloor', threadId: target.threadId })
    rig.proxy.up()
    await untilThread(a, target, (state) => state.notices.length === 1, 'the snapshot')
    expect(thread(a, target)?.turns.at(-1)?.failure?.action).toBe('compact')
    await expectConverges('N3', rig, a)
  })

  scenario('N4 notices and a failure survive a restart and a reload', {}, async (rig) => {
    const a = await rig.connect('A')
    const { target } = await claudeTurn(rig, a)
    await emit(rig, compacted)
    await rig.provider({ op: 'claudeComplete', failure: tooLong })
    await untilThread(a, target, (state) => state.turns.at(-1)?.state === 'failed', 'the failure')
    const before = a.connects
    await rig.restart()
    await until(() => a.connects > before, 'A to reconnect', 20_000)
    await until(() => !a.busy(), 'A to finish its reconnect')
    await expectConverges('N4 after the restart', rig, a)
    const reloaded = await rig.reload(a)
    await untilThread(reloaded, target, (state) => state.notices.length === 1, 'the reload')
    expect(thread(reloaded, target)?.turns.at(-1)?.failure?.reason).toBe('context_window_exceeded')
    await expectConverges('N4 after the reload', rig, reloaded)
  })

  scenario('N5 a crash cuts a turn off with a notice placed in it', {}, async (rig) => {
    const a = await rig.connect('A')
    const { target } = await claudeTurn(rig, a)
    await emit(rig, compacted, retry(1))
    await until(() => live(a, target).length === 1, 'A to show the retry')
    const before = a.connects
    await rig.crash()
    await until(() => a.connects > before, 'A to reconnect', 20_000)
    await until(() => !a.busy(), 'A to finish its reconnect')
    await untilThread(a, target, (state) => state.turns.at(-1)?.state === 'interrupted', 'the end')
    expect(live(a, target), 'a fresh load shows no live notice').toEqual([])
    expect(noticeKinds(a, target)).toEqual(['compacted'])
    await expectConverges('N5', rig, a)
  })

  scenario('N6 the server ends a live notice, for every client', {}, async (rig) => {
    const a = await rig.connect('A')
    const { target } = await claudeTurn(rig, a)
    const b = await rig.connect('B')
    await b.client.commands.openSession(target.sessionId)
    await until(() => !b.busy(), 'B to open the chat')
    const mark = rig.proxy.frames.length
    await emit(rig, retry(1))
    await emit(rig, retry(2))
    for (const client of [a, b]) {
      await until(
        () => thread(client, target)?.liveNotices[0]?.retry?.attempt === 2,
        'the newest attempt',
      )
      expect(live(client, target), 'one per turn').toEqual(['retrying'])
    }
    await emit(rig, words('Back on track'))
    for (const client of [a, b]) {
      await until(() => live(client, target).length === 0, 'the notice to end')
    }
    expect(transientNames(rig.proxy.frames.slice(mark))).toContain('turn.notice.cleared')
    await emit(rig, compacting)
    await until(() => live(a, target).length === 1, 'A to show the compaction')
    await rig.provider({ op: 'claudeComplete' })
    await until(() => live(a, target).length === 0, 'the turn end to end it')
    await expectConverges('N6', rig, a)
  })

  scenario('N7 a live notice whose end was lost goes with the catch-up', {}, async (rig) => {
    const a = await rig.connect('A')
    const { target } = await claudeTurn(rig, a)
    await emit(rig, words('Before'), retry(1))
    await until(() => live(a, target).length === 1, 'A to show the retry')
    rig.proxy.down()
    rig.proxy.cut()
    // The notice ends while A cannot hear it.
    await emit(rig, words(' and after'))
    await rig.waitQuiet()
    rig.proxy.up()
    await untilThread(
      a,
      target,
      (state) => JSON.stringify(state.messages).includes('and after'),
      'the replay',
    )
    expect(live(a, target), 'a fresh load shows none').toEqual([])
    await expectConverges('N7', rig, a)
  })

  scenario('N8 an image that could not be stored stays explained', {}, async (rig) => {
    const a = await rig.connect('A')
    const target = await createSession(rig, a, { quiet: true })
    await startTurn(a, target)
    await rig.provider({ op: 'emitUnstorableImage', sessionId: target.sessionId })
    await untilThread(a, target, (state) => state.notices.length === 1, 'the notice')
    expect(thread(a, target)?.notices[0]).toMatchObject({
      kind: 'warning',
      message: 'A generated image could not be stored.',
    })
    const reloaded = await rig.reload(a)
    await untilThread(reloaded, target, (state) => state.notices.length === 1, 'the reload')
    await expectConverges('N8', rig, reloaded)
  })

  scenario('N10 a notice stays in place among bare deltas and closed tools', {}, async (rig) => {
    const a = await rig.connect('A')
    const target = await createSession(rig, a, { quiet: true })
    await startTurn(a, target)
    const { sessionId } = target
    await rig.provider({
      op: 'openTool',
      sessionId,
      toolCallId: 'n10-1',
      title: 'bash',
      kind: 'execute',
    })
    await rig.provider({ op: 'streamToolLines', sessionId, toolCallId: 'n10-1', lines: 40 })
    await rig.provider({ op: 'emitUnstorableImage', sessionId })
    await untilThread(a, target, (state) => state.notices.length === 1, 'the notice')
    rig.proxy.down()
    rig.proxy.cut()
    await rig.provider({ op: 'streamToolLines', sessionId, toolCallId: 'n10-1', lines: 80 })
    await rig.provider({
      op: 'openTool',
      sessionId,
      toolCallId: 'n10-2',
      title: 'bash',
      kind: 'execute',
    })
    await rig.provider({ op: 'completeTurn', sessionId })
    await rig.waitQuiet()
    rig.proxy.up()
    await untilThread(a, target, (state) => state.turns.at(-1)?.state === 'completed', 'the replay')
    expect(orderKinds(a, target)).toEqual(['message', 'tool', 'notice', 'tool'])
    expect(thread(a, target)?.tools.map((tool) => tool.status)).toEqual(['cancelled', 'cancelled'])
    await expectConverges('N10', rig, a)
  })

  scenario('N9 a retry after a reload resends the failed prompt as a new turn', {}, async (rig) => {
    const a = await rig.connect('A')
    const { target, turnId } = await claudeTurn(rig, a)
    await rig.provider({ op: 'claudeComplete', failure: tooLong })
    await untilThread(a, target, (state) => state.turns.at(-1)?.state === 'failed', 'the failure')
    const reloaded = await rig.reload(a)
    await untilThread(reloaded, target, (state) => state.turns.length === 1, 'the reload')
    // What the row's button sends: the failed turn's own prompt.
    const prompt = resendablePrompt(thread(reloaded, target)!.messages, turnId)!
    expect(prompt).toEqual({ text: 'Prompt 1', artifactIds: [] })
    await reloaded.client.commands.sendTurn({ ...target, text: prompt.text })
    await rig.provider({ op: 'claudeWaitPrompt', prompts: 2 })
    await rig.provider({ op: 'claudeComplete' })
    await untilThread(
      reloaded,
      target,
      (state) => state.turns.at(-1)?.state === 'completed',
      'done',
    )
    const turns = thread(reloaded, target)!.turns
    expect(turns.map((turn) => turn.state)).toEqual(['failed', 'completed'])
    expect(thread(reloaded, target)!.messages.filter((item) => item.role === 'user')).toHaveLength(
      2,
    )
    expect(turns[0]?.failure?.reason).toBe('context_window_exceeded')
    await expectConverges('N9', rig, reloaded)
  })
})
