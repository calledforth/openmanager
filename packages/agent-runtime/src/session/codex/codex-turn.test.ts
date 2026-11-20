import type { MessagePhase, v2 } from '@openmanager/codex-app-server-protocol'
import { describe, expect, it } from 'vitest'
import { CodexRpcError } from './CodexRpcPeer.js'
import { codexInput, CodexSteerRefusedError, isMissingThread, steerRefusal } from './CodexSessionRuntime.js'
import { CodexTurn, type CodexTurnOutput } from './codex-turn.js'

function turn() {
  const out: CodexTurnOutput[] = []
  return { turn: new CodexTurn((o) => out.push(o)), out }
}

const ids = { threadId: 'th', turnId: 'tu' }

function message(id: string, text: string, phase: MessagePhase | null = null): v2.ThreadItem {
  return {
    type: 'agentMessage',
    id,
    text,
    phase,
    moderation: null,
    memoryCitation: null,
    delivery: null,
    questions: null,
  } as v2.ThreadItem
}

function reasoning(id: string, summary: string[] = []): v2.ThreadItem {
  return { type: 'reasoning', id, summary, content: [] } as v2.ThreadItem
}

const text = (out: CodexTurnOutput[]) =>
  out
    .filter((o) => o.event === 'agent_message_chunk')
    .map((o) => (o.data as { content: { text: string } }).content.text)
    .join('')

describe('CodexTurn', () => {
  it('streams assistant text and does not repeat it on completion', () => {
    const { turn: t, out } = turn()
    t.itemStarted(message('m1', ''))
    t.agentMessageDelta({ ...ids, itemId: 'm1', delta: 'Hel' })
    t.agentMessageDelta({ ...ids, itemId: 'm1', delta: 'lo' })
    t.itemCompleted(message('m1', 'Hello'))
    expect(text(out)).toBe('Hello')
  })

  // A short message can arrive whole, with no deltas at all.
  it('backfills a message that never streamed', () => {
    const { turn: t, out } = turn()
    t.itemStarted(message('m1', ''))
    t.itemCompleted(message('m1', 'All at once'))
    expect(text(out)).toBe('All at once')
  })

  it('frames reasoning summaries as start, deltas per part, stop', () => {
    const { turn: t, out } = turn()
    t.itemStarted(reasoning('r1'))
    t.reasoningPartAdded({ ...ids, itemId: 'r1', summaryIndex: 0 })
    t.reasoningSummaryDelta({ ...ids, itemId: 'r1', delta: '**Reading files**', summaryIndex: 0 })
    t.reasoningPartAdded({ ...ids, itemId: 'r1', summaryIndex: 1 })
    t.reasoningSummaryDelta({ ...ids, itemId: 'r1', delta: '**Writing tests**', summaryIndex: 1 })
    t.itemCompleted(reasoning('r1', ['**Reading files**', '**Writing tests**']))
    expect(out.map((o) => o.event === 'agent_thought_chunk' && o.data)).toEqual([
      { messageId: 'r1', phase: 'start' },
      { messageId: 'r1', phase: 'delta', content: { type: 'text', text: '**Reading files**' } },
      { messageId: 'r1', phase: 'delta', content: { type: 'text', text: '\n\n' } },
      { messageId: 'r1', phase: 'delta', content: { type: 'text', text: '**Writing tests**' } },
      { messageId: 'r1', phase: 'stop' },
    ])
  })

  // Without `summary: "detailed"`, or on a short item, the summary may only
  // be on the completed item.
  it('backfills a reasoning summary that never streamed, and skips an empty one', () => {
    const { turn: t, out } = turn()
    t.itemStarted(reasoning('r1'))
    t.itemCompleted(reasoning('r1', ['**Planning**']))
    t.itemStarted(reasoning('r2'))
    t.itemCompleted(reasoning('r2'))
    expect(out.map((o) => (o.data as { phase?: string }).phase)).toEqual([
      'start',
      'delta',
      'stop',
      'start',
      'stop',
    ])
  })

  it('closes reasoning still open when the turn ends', () => {
    const { turn: t, out } = turn()
    t.itemStarted(reasoning('r1'))
    t.finish()
    t.finish()
    expect(out.map((o) => (o.data as { phase?: string }).phase)).toEqual(['start', 'stop'])
  })

  it('ignores our own userMessage echo and items it does not translate', () => {
    const { turn: t, out } = turn()
    t.itemStarted({ type: 'userMessage', id: 'u', clientId: null, content: [] } as v2.ThreadItem)
    t.itemStarted({ type: 'imageView', id: 'i', path: '/x.png' } as v2.ThreadItem)
    expect(out.filter((o) => o.event !== 'tool_call' && o.event !== 'tool_call_update')).toEqual([])
  })

  it('hands tool items and tool notifications to the tool translator', () => {
    const { turn: t, out } = turn()
    t.itemStarted({ type: 'webSearch', id: 'w', query: 'codex', action: null, results: null })
    expect(t.toolNotification('item/mcpToolCall/progress', { itemId: 'w', message: 'x' })).toBe(true)
    expect(t.toolNotification('item/agentMessage/delta', {})).toBe(false)
    t.itemCompleted({ type: 'webSearch', id: 'w', query: 'codex', action: null, results: null })
    expect(out.map((output) => output.event)).toEqual(['tool_call', 'tool_call_content', 'tool_call_update'])
  })

  it('reports this turn’s tokens and the context window', () => {
    const { turn: t } = turn()
    expect(t.usage).toBeUndefined()
    const breakdown = {
      totalTokens: 120,
      inputTokens: 100,
      cachedInputTokens: 40,
      cacheWriteInputTokens: 0,
      outputTokens: 20,
      reasoningOutputTokens: 8,
    }
    t.tokenUsageUpdated({ total: breakdown, last: breakdown, modelContextWindow: 400_000 })
    expect(t.usage).toEqual({
      totalTokens: 120,
      inputTokens: 100,
      outputTokens: 20,
      thoughtTokens: 8,
      cachedReadTokens: 40,
      cachedWriteTokens: 0,
    })
    expect(t.contextUsage).toEqual({ used: 120, size: 400_000 })
    t.tokenUsageUpdated({ total: breakdown, last: breakdown, modelContextWindow: null })
    expect(t.contextUsage).toBeUndefined()
  })
})

describe('codexInput', () => {
  it('joins text blocks and sends images as data URLs', () => {
    expect(
      codexInput({
        text: 'look',
        blocks: [
          { type: 'text', text: 'look' },
          { type: 'image', mimeType: 'image/png', data: 'AAAA' },
          { type: 'text', text: 'here' },
        ],
      }),
    ).toEqual([
      { type: 'text', text: 'look\n\nhere', text_elements: [] },
      { type: 'image', url: 'data:image/png;base64,AAAA' },
    ])
  })

  it('refuses what Codex cannot take, before the turn starts', () => {
    expect(() =>
      codexInput({ text: '', blocks: [{ type: 'audio', mimeType: 'audio/wav', data: '' }] }),
    ).toThrow(/audio/)
  })
})

describe('isMissingThread', () => {
  it('matches the not-found answers Codex gives, and nothing else', () => {
    expect(isMissingThread(new CodexRpcError(-32600, 'no rollout found for thread id x'))).toBe(true)
    expect(isMissingThread(new CodexRpcError(-32600, 'invalid session id: bad'))).toBe(true)
    expect(isMissingThread(new CodexRpcError(-32600, 'model not allowed'))).toBe(false)
    // Only the not-found answers Codex was probed giving; anything broader
    // would quietly replace the user's thread.
    expect(isMissingThread(new CodexRpcError(-32600, 'thread not found'))).toBe(false)
    expect(isMissingThread(new CodexRpcError(-32603, 'no rollout found for thread id x'))).toBe(false)
    expect(isMissingThread(new Error('no rollout found'))).toBe(false)
  })
})

describe('steerRefusal', () => {
  it('tells a turn that ended or is another one from one that cannot be steered', () => {
    const ended = steerRefusal(new CodexRpcError(-32600, 'no active turn to steer'))
    expect(ended).toBeInstanceOf(CodexSteerRefusedError)
    expect(ended).toMatchObject({ reason: 'turn_ended' })
    expect(
      steerRefusal(new CodexRpcError(-32600, 'expected active turn id `a` but found `b`')),
    ).toMatchObject({ reason: 'turn_ended' })
    expect(
      steerRefusal(
        new CodexRpcError(-32600, 'cannot steer a review turn', {
          codexErrorInfo: { activeTurnNotSteerable: { turnKind: 'review' } },
        }),
      ),
    ).toMatchObject({ reason: 'not_steerable' })
    expect(steerRefusal(new CodexRpcError(-32600, 'active turn is not steerable'))).toMatchObject({
      reason: 'not_steerable',
    })
    // Not a refusal: passed on as it is.
    const other = new Error('codex app-server did not answer turn/steer within 30000ms')
    expect(steerRefusal(other)).toBe(other)
  })
})

describe('CodexTurn steers', () => {
  const userMessage = (text: string, clientId: string | null = null) =>
    ({ type: 'userMessage', id: `u-${text}`, clientId, content: [{ type: 'text', text, text_elements: [] }] }) as v2.ThreadItem
  const input = (text: string): v2.UserInput[] => [{ type: 'text', text, text_elements: [] }]

  it('places a steer at its echo, known by client id, once', () => {
    const { turn: t, out } = turn()
    t.expectSteer('s1', input('also this'))
    // The prompt's echo, with its own client id, is not a steer.
    t.itemStarted(userMessage('the prompt', 'prompt-1'))
    t.itemCompleted(userMessage('the prompt', 'prompt-1'))
    expect(out).toEqual([])
    t.itemStarted(userMessage('also this', 's1'))
    t.itemCompleted(userMessage('also this', 's1'))
    expect(out).toEqual([{ event: 'steer_delivered', data: { steerId: 's1' } }])
    t.finish()
    expect(out).toHaveLength(1)
  })

  // A recording made without client ids: the echo is matched by its words.
  it('matches an echo without a client id by its words, oldest first', () => {
    const { turn: t, out } = turn()
    t.expectSteer('s1', input('same'))
    t.expectSteer('s2', input('same'))
    t.itemStarted(userMessage('the prompt'))
    t.itemStarted(userMessage('same'))
    expect(out).toEqual([{ event: 'steer_delivered', data: { steerId: 's1' } }])
  })

  // Each echo arrives twice (started, completed). With identical words and no
  // client ids, the second sighting of the first echo must not claim the
  // second steer; nor may the prompt's echo, first in the turn, claim one.
  it('counts each echo once and never takes the prompt’s for a steer', () => {
    const { turn: t, out } = turn()
    t.expectSteer('s1', input('same'))
    t.expectSteer('s2', input('same'))
    const prompt = { ...userMessage('same'), id: 'prompt' } as v2.ThreadItem
    t.itemStarted(prompt)
    t.itemCompleted(prompt)
    expect(out).toEqual([])
    const first = { ...userMessage('same'), id: 'echo-1' } as v2.ThreadItem
    t.itemStarted(first)
    t.itemCompleted(first)
    expect(out).toEqual([{ event: 'steer_delivered', data: { steerId: 's1' } }])
    const second = { ...userMessage('same'), id: 'echo-2' } as v2.ThreadItem
    t.itemStarted(second)
    t.itemCompleted(second)
    expect(out.map((o) => o.data)).toEqual([{ steerId: 's1' }, { steerId: 's2' }])
  })

  it('holds a delivery while a message or thought streams, and reports it at the end at the latest', () => {
    const { turn: t, out } = turn()
    t.expectSteer('s1', input('a'))
    t.expectSteer('s2', input('b'))
    t.itemStarted(message('m1', ''))
    t.agentMessageDelta({ ...ids, itemId: 'm1', delta: 'Hel' })
    t.itemStarted(userMessage('a', 's1'))
    t.agentMessageDelta({ ...ids, itemId: 'm1', delta: 'lo' })
    expect(out.some((o) => o.event === 'steer_delivered')).toBe(false)
    t.itemCompleted(message('m1', 'Hello'))
    expect(out.at(-1)).toEqual({ event: 'steer_delivered', data: { steerId: 's1' } })
    // A thought left open by an interrupted turn: delivered when it ends.
    t.itemStarted(reasoning('r1'))
    t.itemStarted(userMessage('b', 's2'))
    expect(out.filter((o) => o.event === 'steer_delivered')).toHaveLength(1)
    t.finish()
    expect(out.filter((o) => o.event.startsWith('steer_'))).toEqual([
      { event: 'steer_delivered', data: { steerId: 's1' } },
      { event: 'steer_delivered', data: { steerId: 's2' } },
    ])
  })

  it('counts a steer Codex never answered as placed when the turn is closed early', () => {
    const { turn: t, out } = turn()
    t.expectSteer('s1', input('one'))
    t.expectSteer('s2', input('two'))
    t.steerAnswered('s2')
    expect(t.placeUnansweredSteers()).toEqual(['s1'])
    t.finish()
    expect(out).toEqual([
      { event: 'steer_delivered', data: { steerId: 's1' } },
      { event: 'steer_withdrawn', data: { steerId: 's2' } },
    ])
  })

  it('gives back a steer the turn ended without echoing, and forgets a refused one', () => {
    const { turn: t, out } = turn()
    t.expectSteer('s1', input('one'))
    t.expectSteer('s2', input('two'))
    expect(t.forgetSteer('s2')).toBe(true)
    expect(t.forgetSteer('s2')).toBe(false)
    t.finish()
    expect(out).toEqual([{ event: 'steer_withdrawn', data: { steerId: 's1' } }])
    expect(t.forgetSteer('s1')).toBe(false)
  })
})

describe('CodexTurn message phases', () => {
  // Narration and answer are separate Codex messages; each chunk says which,
  // so the host can keep them apart.
  it('stamps every chunk with its message’s phase, streamed or backfilled', () => {
    const { turn: t, out } = turn()
    t.itemStarted(message('m1', '', 'commentary'))
    t.agentMessageDelta({ ...ids, itemId: 'm1', delta: 'Reading greet.py.' })
    t.itemCompleted(message('m1', 'Reading greet.py.', 'commentary'))
    t.itemStarted(message('m2', '', 'final_answer'))
    t.itemCompleted(message('m2', 'It greets.', 'final_answer'))
    t.itemStarted(message('m3', ''))
    t.agentMessageDelta({ ...ids, itemId: 'm3', delta: 'no phase' })
    expect(out.map((o) => o.data)).toEqual([
      {
        messageId: 'm1',
        content: { type: 'text', text: 'Reading greet.py.' },
        phase: 'commentary',
      },
      { messageId: 'm2', content: { type: 'text', text: 'It greets.' }, phase: 'final_answer' },
      { messageId: 'm3', content: { type: 'text', text: 'no phase' } },
    ])
  })
})

describe('CodexTurn item ids', () => {
  // The host keeps Codex's item id beside the message or thought it files a
  // chunk under: every chunk names its item, streamed, backfilled or framing.
  it('names the item on every chunk it emits', () => {
    const { turn: t, out } = turn()
    t.itemStarted(reasoning('rs_1'))
    t.reasoningSummaryDelta({ ...ids, itemId: 'rs_1', delta: 'Plan', summaryIndex: 0 })
    t.itemCompleted(reasoning('rs_1', ['Plan']))
    t.itemStarted(message('msg_1', '', 'commentary'))
    t.agentMessageDelta({ ...ids, itemId: 'msg_1', delta: 'Looking.' })
    t.itemCompleted(message('msg_1', 'Looking.', 'commentary'))
    t.itemStarted(message('msg_2', '', 'final_answer'))
    t.itemCompleted(message('msg_2', 'Done.', 'final_answer'))
    t.itemStarted(reasoning('rs_2'))
    t.finish()
    expect(out.map((o) => [o.event, (o.data as { messageId?: string }).messageId])).toEqual([
      ['agent_thought_chunk', 'rs_1'],
      ['agent_thought_chunk', 'rs_1'],
      ['agent_thought_chunk', 'rs_1'],
      ['agent_message_chunk', 'msg_1'],
      ['agent_message_chunk', 'msg_2'],
      ['agent_thought_chunk', 'rs_2'],
      ['agent_thought_chunk', 'rs_2'],
    ])
  })
})

describe('CodexTurn reasoning parts', () => {
  // Codex may skip `summaryPartAdded`; the part index alone keeps headlines apart.
  it('separates headlines by part index without summaryPartAdded', () => {
    const { turn: t, out } = turn()
    t.itemStarted(reasoning('r1'))
    t.reasoningSummaryDelta({ ...ids, itemId: 'r1', delta: '**One**', summaryIndex: 0 })
    t.reasoningSummaryDelta({ ...ids, itemId: 'r1', delta: '**Two**', summaryIndex: 1 })
    const deltas = out
      .filter((o) => o.event === 'agent_thought_chunk' && (o.data as { phase: string }).phase === 'delta')
      .map((o) => (o.data as { content: { text: string } }).content.text)
    expect(deltas).toEqual(['**One**', '\n\n', '**Two**'])
  })
})

describe('CodexTurn operations', () => {
  const usage = (last: number): v2.ThreadTokenUsage => {
    const breakdown = (total: number) => ({
      totalTokens: total,
      inputTokens: total,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
    })
    return { total: breakdown(20_000), last: breakdown(last), modelContextWindow: 200_000 }
  }
  const notices = (out: CodexTurnOutput[]) =>
    out.filter((o) => o.event === 'provider_notice').map((o) => o.data)

  it('a compaction: compacting while it runs, compacted once, then the meter from the emptied window', () => {
    const out: CodexTurnOutput[] = []
    const t = new CodexTurn((o) => out.push(o), undefined, undefined, 'compact')
    t.tokenUsageUpdated(usage(150_000))
    t.itemStarted({ type: 'contextCompaction', id: 'c' })
    t.tokenUsageUpdated(usage(9_000))
    t.itemCompleted({ type: 'contextCompaction', id: 'c' })
    t.itemCompleted({ type: 'contextCompaction', id: 'c' })
    expect(out.map((o) => o.event)).toEqual(['provider_notice', 'provider_notice', 'usage_update'])
    expect(notices(out)).toEqual([
      { kind: 'compacting', message: 'Compacting the conversation' },
      { kind: 'compacted', message: 'Conversation compacted', compaction: { trigger: 'manual' } },
    ])
    expect(out.at(-1)).toEqual({ event: 'usage_update', data: { used: 9_000, size: 200_000 } })
    // The deprecated notification after the item says nothing more.
    t.threadCompacted()
    expect(notices(out)).toHaveLength(2)
  })

  it('an automatic compaction inside a prompted turn, and thread/compacted from a Codex with no item', () => {
    const auto = turn()
    auto.turn.itemStarted({ type: 'contextCompaction', id: 'c' })
    auto.turn.itemCompleted({ type: 'contextCompaction', id: 'c' })
    // No reading during it: the meter waits for the turn's own.
    expect(auto.out.map((o) => o.event)).toEqual(['provider_notice', 'provider_notice'])
    expect(notices(auto.out)[1]).toEqual({
      kind: 'compacted',
      message: 'Conversation compacted automatically',
      compaction: { trigger: 'auto' },
    })

    const legacy = turn()
    legacy.turn.threadCompacted()
    expect(notices(legacy.out)).toEqual([
      { kind: 'compacted', message: 'Conversation compacted automatically', compaction: { trigger: 'auto' } },
    ])
  })

  it('a review: its markers once each, then its findings as the answer, not repeated', () => {
    const out: CodexTurnOutput[] = []
    const t = new CodexTurn((o) => out.push(o), undefined, undefined, 'review')
    const entered = { type: 'enteredReviewMode', id: 'e', review: 'current changes' } as const
    t.itemStarted(entered)
    t.itemCompleted(entered)
    // Codex's own prompt for the review is not ours to show.
    t.itemStarted({
      type: 'userMessage',
      id: 'u',
      clientId: null,
      content: [{ type: 'text', text: 'Review the current code changes', text_elements: [] }],
    } as v2.ThreadItem)
    // The model's own message in review mode never streams.
    t.itemStarted(message('m-model', '', 'final_answer'))
    const findings = '- [P1] Return the sum — add.js:2'
    const exited = { type: 'exitedReviewMode', id: 'x', review: findings } as const
    t.itemStarted(exited)
    t.itemCompleted(exited)
    t.itemStarted(message('m-again', findings))
    t.itemCompleted(message('m-again', findings))
    t.finish(true)
    expect(notices(out)).toEqual([
      {
        kind: 'info',
        message: 'Reviewing current changes',
        review: { phase: 'started', target: 'current changes' },
      },
      { kind: 'info', message: 'Review finished', review: { phase: 'finished' } },
    ])
    expect(out.filter((o) => o.event === 'agent_message_chunk').map((o) => o.data)).toEqual([
      { messageId: 'x', content: { type: 'text', text: findings }, phase: 'final_answer' },
    ])
  })

  it('a stopped review shows why, not that the reviewer failed', () => {
    const out: CodexTurnOutput[] = []
    const t = new CodexTurn((o) => out.push(o), undefined, undefined, 'review')
    t.interruptRequested = true
    t.itemCompleted({ type: 'exitedReviewMode', id: 'x', review: 'Reviewer failed to output a response.' })
    t.itemStarted(message('m', 'Review was interrupted. Please re-run /review.'))
    t.itemCompleted(message('m', 'Review was interrupted. Please re-run /review.'))
    expect(notices(out)).toEqual([{ kind: 'info', message: 'Review finished', review: { phase: 'finished' } }])
    expect(text(out)).toBe('Review was interrupted. Please re-run /review.')
  })
})
