// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { MessageSearchHit } from '@openmanager/protocol'
import {
  chatSearchStatus,
  matchesWords,
  mergeSearchHits,
  searchWords,
  snippetRuns,
  useChatSearch,
  withoutLeadingEllipsis,
  type ChatSearchSource,
  type ChatSearchState,
} from './chat-search'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const hit = (sessionId: string, at = '2026-11-10T10:00:00.000Z'): MessageSearchHit => ({
  sessionId,
  workspaceId: 'w',
  title: sessionId,
  messageId: `${sessionId}-m`,
  role: 'assistant',
  at,
  snippet: 'text',
  highlights: [],
  matches: 1,
})

describe('title words', () => {
  it('needs every word, in any order, ignoring case', () => {
    const words = searchWords('  Tool PAY ')
    expect(words).toEqual(['tool', 'pay'])
    expect(matchesWords(words, 'Tool Call Payloads')).toBe(true)
    expect(matchesWords(words, 'Payloads', 'tools project')).toBe(true)
    expect(matchesWords(words, 'Tool Call')).toBe(false)
    expect(matchesWords([], 'anything')).toBe(false)
  })
})

describe('mergeSearchHits', () => {
  it('interleaves by place, never by score, so no environment drowns the others', () => {
    const merged = mergeSearchHits([
      { environmentId: 'desktop', hits: [hit('d1'), hit('d2'), hit('d3')] },
      { environmentId: 'laptop', hits: [hit('l1')] },
    ])
    expect(merged.map((h) => [h.environmentId, h.sessionId])).toEqual([
      ['desktop', 'd1'],
      ['laptop', 'l1'],
      ['desktop', 'd2'],
      ['desktop', 'd3'],
    ])
  })

  it('puts the newer message first within one place, and keeps order on a tie', () => {
    const merged = mergeSearchHits([
      { environmentId: 'a', hits: [hit('old', '2026-11-01T00:00:00.000Z')] },
      { environmentId: 'b', hits: [hit('new', '2026-11-09T00:00:00.000Z')] },
      { environmentId: 'c', hits: [hit('same', '2026-11-09T00:00:00.000Z')] },
    ])
    expect(merged.map((h) => h.sessionId)).toEqual(['new', 'same', 'old'])
  })

  it('is empty for no answers', () => {
    expect(mergeSearchHits([])).toEqual([])
    expect(mergeSearchHits([{ environmentId: 'a', hits: [] }])).toEqual([])
  })
})

describe('snippets', () => {
  it('drops a leading ellipsis and shifts the highlights with it', () => {
    expect(
      withoutLeadingEllipsis({ snippet: '… the reconnect loop', highlights: [[6, 15]] }),
    ).toEqual({ text: 'the reconnect loop', highlights: [[4, 13]] })
    expect(
      withoutLeadingEllipsis({
        snippet: '…loop',
        highlights: [
          [0, 1],
          [1, 5],
        ],
      }),
    ).toEqual({
      text: 'loop',
      highlights: [[0, 4]],
    })
    const plain = { snippet: 'plain…', highlights: [[0, 5]] as [number, number][] }
    expect(withoutLeadingEllipsis(plain)).toEqual({ text: 'plain…', highlights: [[0, 5]] })
  })

  it('cuts the text into runs that join back into it, matches marked', () => {
    expect(snippetRuns('the reconnect loop', [[4, 13]])).toEqual([
      { start: 0, text: 'the ', match: false },
      { start: 4, text: 'reconnect', match: true },
      { start: 13, text: ' loop', match: false },
    ])
    expect(snippetRuns('abc', [[0, 3]])).toEqual([{ start: 0, text: 'abc', match: true }])
    expect(snippetRuns('abc', [])).toEqual([{ start: 0, text: 'abc', match: false }])
  })

  it('skips a highlight that overlaps the one before or runs past the text', () => {
    const runs = snippetRuns('abcdef', [
      [0, 3],
      [2, 4],
      [4, 9],
    ])
    expect(runs.map((run) => run.text).join('')).toBe('abcdef')
    expect(runs.filter((run) => run.match).map((run) => run.text)).toEqual(['abc'])
  })
})

describe('chatSearchStatus', () => {
  const name = (id: string) => ({ desk: 'Desk' })[id]

  it('says nothing with nothing typed or nothing failed', () => {
    expect(chatSearchStatus('  ', { failed: ['desk'] }, 1, name)).toBeNull()
    expect(chatSearchStatus('loop', { failed: [] }, 1, name)).toBeNull()
  })

  it('names each environment that could not be searched', () => {
    expect(chatSearchStatus('loop', { failed: ['desk', 'gone'] }, 2, name)).toBe(
      'Couldn’t search Desk, An environment.',
    )
  })

  it('says why there is no message search with no capable environment', () => {
    expect(chatSearchStatus('loop', { failed: [] }, 0, name)).toBe(
      'Message search needs a connected environment on a newer server.',
    )
  })
})

describe('useChatSearch', () => {
  let root: Root | null = null
  let host: HTMLElement | null = null
  let latest: ChatSearchState | null = null

  function Probe(props: { query: string; sources: readonly ChatSearchSource[] }) {
    latest = useChatSearch(props.query, props.sources, { debounceMs: 200, timeoutMs: 3000 })
    return null
  }
  const render = (query: string, sources: readonly ChatSearchSource[]) =>
    act(() => root!.render(createElement(Probe, { query, sources })))
  const flush = async (ms: number) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms)
    })
  }

  beforeEach(() => {
    vi.useFakeTimers()
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })
  afterEach(() => {
    act(() => root?.unmount())
    host?.remove()
    vi.useRealTimers()
    latest = null
  })

  type Pending = { query: string; resolve: (hits: MessageSearchHit[]) => void; reject: () => void }
  const deferredSource = (environmentId: string) => {
    const calls: Pending[] = []
    const source: ChatSearchSource = {
      environmentId,
      search: (query) =>
        new Promise((resolve, reject) =>
          calls.push({ query, resolve, reject: () => reject(new Error('down')) }),
        ),
    }
    return { source, calls }
  }

  it('asks nothing for an empty query or with no sources', async () => {
    const { source, calls } = deferredSource('a')
    render('   ', [source])
    await flush(500)
    expect(calls).toHaveLength(0)
    expect(latest).toEqual({ query: '', hits: [], pending: false, failed: [] })
    render('word', [])
    await flush(500)
    expect(latest?.pending).toBe(false)
  })

  it('waits for typing to settle, then asks every source once with the trimmed query', async () => {
    const a = deferredSource('a')
    const b = deferredSource('b')
    const sources = [a.source, b.source]
    render('b', sources)
    await flush(100)
    render('ba', sources)
    await flush(100)
    render('back ', sources)
    expect(a.calls).toHaveLength(0)
    await flush(200)
    expect(a.calls.map((c) => c.query)).toEqual(['back'])
    expect(b.calls.map((c) => c.query)).toEqual(['back'])
    expect(latest?.pending).toBe(true)

    await act(async () => a.calls[0]!.resolve([hit('a1')]))
    expect(latest).toMatchObject({ query: 'back', pending: true })
    expect(latest?.hits.map((h) => h.sessionId)).toEqual(['a1'])

    await act(async () => b.calls[0]!.resolve([hit('b1')]))
    expect(latest?.pending).toBe(false)
    expect(latest?.hits.map((h) => [h.environmentId, h.sessionId])).toEqual([
      ['a', 'a1'],
      ['b', 'b1'],
    ])
  })

  it('drops an answer to an older query, and keeps the last hits until the new ones land', async () => {
    const a = deferredSource('a')
    const sources = [a.source]
    render('first', sources)
    await flush(200)
    await act(async () => a.calls[0]!.resolve([hit('one')]))
    render('second', sources)
    await flush(200)
    // Still showing what "first" found while "second" is out.
    expect(latest).toMatchObject({ query: 'first', pending: true })
    expect(latest?.hits.map((h) => h.sessionId)).toEqual(['one'])

    render('third', sources)
    await flush(200)
    await act(async () => a.calls[1]!.resolve([hit('stale')]))
    expect(latest?.hits.map((h) => h.sessionId)).toEqual(['one'])
    await act(async () => a.calls[2]!.resolve([hit('fresh')]))
    expect(latest).toMatchObject({ query: 'third', pending: false })
    expect(latest?.hits.map((h) => h.sessionId)).toEqual(['fresh'])
  })

  it('names the sources that failed or timed out, and still shows the others', async () => {
    const a = deferredSource('a')
    const b = deferredSource('b')
    const c = deferredSource('c')
    render('word', [a.source, b.source, c.source])
    await flush(200)
    await act(async () => a.calls[0]!.resolve([hit('a1')]))
    await act(async () => b.calls[0]!.reject())
    await flush(3000)
    expect(latest).toMatchObject({ pending: false, failed: ['b', 'c'] })
    expect(latest?.hits.map((h) => h.sessionId)).toEqual(['a1'])
  })
})
