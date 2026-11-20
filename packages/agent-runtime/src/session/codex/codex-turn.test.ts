import type { MessagePhase, v2 } from '@openmanager/codex-app-server-protocol'
import { describe, expect, it } from 'vitest'
import { CodexRpcError } from './CodexRpcPeer.js'
import { codexInput, isMissingThread } from './CodexSessionRuntime.js'
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
      { phase: 'start' },
      { phase: 'delta', content: { type: 'text', text: '**Reading files**' } },
      { phase: 'delta', content: { type: 'text', text: '\n\n' } },
      { phase: 'delta', content: { type: 'text', text: '**Writing tests**' } },
      { phase: 'stop' },
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
    t.itemStarted({ type: 'webSearch', id: 'w' } as unknown as v2.ThreadItem)
    expect(out).toEqual([])
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
    expect(isMissingThread(new Error('no rollout found'))).toBe(false)
  })
})
