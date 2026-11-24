// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Subagent } from '@openmanager/protocol'
import { ThemeProvider } from '../../providers/theme-provider'
import { MessageParts } from './MessageParts'
import { SubagentGroup } from './SubagentCard'
import { partitionSettledTurnParts } from './turn-work-group'
import {
  formatElapsed,
  subagentElapsedMs,
  subagentGroupSummary,
  subagentModelLabel,
  subagentName,
  subagentPart,
  subagentStatusLabel,
  subagentToolCount,
} from './subagent-card'

const subagent = (patch: Partial<Subagent> = {}): Subagent => ({
  subagentId: 'sa-1',
  parentSessionId: 'parent',
  turnId: 't1',
  toolCallId: 'call-1',
  depth: 1,
  origin: 'native',
  providerId: 'claude',
  title: 'Map the callers',
  status: 'running',
  background: false,
  promptable: false,
  stoppable: true,
  stats: {},
  startedAt: '2026-11-18T10:00:00.000Z',
  updatedAt: '2026-11-18T10:00:00.000Z',
  ...patch,
})

const START = Date.parse('2026-11-18T10:00:00.000Z')

describe('subagent card logic', () => {
  it('ticks while running and holds the reported time once settled', () => {
    expect(subagentElapsedMs(subagent(), START + 72_000)).toBe(72_000)
    // A reported duration ahead of this clock wins: the card never ticks back.
    expect(subagentElapsedMs(subagent({ stats: { durationMs: 90_000 } }), START + 72_000)).toBe(
      90_000,
    )
    const done = subagent({ status: 'completed', finishedAt: '2026-11-18T10:00:48.000Z' })
    expect(subagentElapsedMs(done, START + 999_000)).toBe(48_000)
    expect(subagentElapsedMs({ ...done, stats: { durationMs: 47_200 } }, START)).toBe(47_200)
    expect(subagentElapsedMs({ ...done, finishedAt: undefined }, START)).toBeUndefined()
  })

  it('formats time and the tool count compactly', () => {
    expect(formatElapsed(8_400)).toBe('8s')
    expect(formatElapsed(72_000)).toBe('1m 12s')
    expect(formatElapsed(120_000)).toBe('2m')
    expect(formatElapsed(3_840_000)).toBe('1h 4m')
    expect(subagentToolCount({ toolCalls: 1, tokens: 31_420 })).toBe('1 tool')
    expect(subagentToolCount({ toolCalls: 14 })).toBe('14 tools')
    expect(subagentToolCount({})).toBe('')
  })

  it('names the status, what a waiting one waits on, and the subagent itself', () => {
    // One vocabulary: what it waits on is said beside the status, not in it.
    expect(subagentStatusLabel({ status: 'waiting', waitingOn: 'question' })).toBe('Needs you')
    expect(subagentStatusLabel({ status: 'running' })).toBe('Working')
    expect(subagentStatusLabel({ status: 'cancelled' })).toBe('Stopped')
    expect(subagentStatusLabel({ status: 'interrupted' })).toBe('Stopped')
    expect(subagentName({ title: '  ', agentType: 'Explore' })).toBe('Explore')
    expect(subagentName({ title: '' })).toBe('Subagent')
  })

  it('shortens a model id, preferring the catalog’s name', () => {
    expect(subagentModelLabel('claude-sonnet-4-5-20250929')).toBe('claude-sonnet-4-5')
    expect(subagentModelLabel('gpt-5.1', [{ modelId: 'gpt-5.1', name: 'GPT-5.1' }])).toBe('GPT-5.1')
    expect(subagentModelLabel(undefined)).toBeUndefined()
  })

  it('sums a group up, waiting first', () => {
    expect(
      subagentGroupSummary([
        { status: 'running' },
        { status: 'completed' },
        { status: 'waiting' },
        { status: 'completed' },
      ]),
    ).toEqual({
      title: '4 subagents',
      detail: '1 needs you, 1 working, 2 done',
      running: true,
      segments: [
        { tone: 'waiting', count: 1 },
        { tone: 'running', count: 1 },
        { tone: 'done', count: 2 },
      ],
    })
    expect(subagentGroupSummary([{ status: 'completed' }, { status: 'failed' }]).running).toBe(
      false,
    )
  })

  it('keeps one part per record, so an unchanged card skips its render', () => {
    const record = subagent()
    expect(subagentPart(record)).toBe(subagentPart(record))
    expect(subagentPart({ ...record })).not.toBe(subagentPart(record))
  })
})

const render = (parts: Parameters<typeof MessageParts>[0]['parts'], isStreaming = true) =>
  renderToStaticMarkup(
    <ThemeProvider>
      <MessageParts parts={parts} isStreaming={isStreaming} />
    </ThemeProvider>,
  )

describe('subagent cards in a turn', () => {
  it('shows a lone subagent as a card: who, what it is doing, what it runs on, how far along', () => {
    const html = render([
      subagentPart(
        subagent({
          agentType: 'Explore',
          background: true,
          activity: 'Reading auth.ts',
          stats: { toolCalls: 3, tokens: 4_100 },
          modelId: 'claude-haiku-4-5-20251001',
        }),
      ),
    ])
    expect(html).toContain('Map the callers')
    expect(html).toContain('Explore')
    expect(html).toContain('claude-haiku-4-5')
    expect(html).toContain('3 tools')
    // What it is doing now, on the second line; no Background pill.
    expect(html).toContain('Reading auth.ts')
    // Working is said by the glyph alone: no status word for it.
    expect(html).not.toContain('>Working<')
    expect(html).not.toContain('Background')
    expect(html).not.toContain('tokens')
    expect(html).not.toContain('role="group"')
    // No environment to ask: no Stop, and no child to open.
    expect(html).not.toContain('Stop')
  })

  it('flags a waiting subagent with what it waits on', () => {
    const question = render([subagentPart(subagent({ status: 'waiting', waitingOn: 'question' }))])
    expect(question).toContain('Needs you')
    expect(question).toContain('Asked you a question')
    expect(question).toContain('data-subagent-status="waiting"')
    const permission = render([
      subagentPart(subagent({ status: 'waiting', waitingOn: 'permission' })),
    ])
    expect(permission).toContain('Waiting for your permission')
  })

  it('keeps a finished one to one line, and says why a failed one failed', () => {
    const done = render([
      subagentPart(
        subagent({
          status: 'completed',
          result: '## Summary\nFound **7** callers in `auth`.\n\nMore.',
        }),
      ),
    ])
    // Done is one line: the answer is on its page.
    expect(done).not.toContain('callers in')
    expect(done).not.toContain('pl-6')
    const failed = render([
      subagentPart(subagent({ status: 'failed', statusReason: 'Postgres is down' })),
    ])
    expect(failed).toContain('Failed')
    expect(failed).toContain('title="Postgres is down"')
  })

  it('folds subagents started back to back into one group, and only those', () => {
    const a = subagentPart(subagent({ subagentId: 'a', title: 'First' }))
    const b = subagentPart(subagent({ subagentId: 'b', title: 'Second', status: 'completed' }))
    const c = subagentPart(subagent({ subagentId: 'c', title: 'Third' }))
    const grouped = render([a, b, c])
    expect(grouped.match(/role="group"/g)).toHaveLength(1)
    expect(grouped).toContain('3 subagents')
    expect(grouped).toContain('2 working, 1 done')
    // Folded: the header and a line of what each runs on, no cards yet.
    expect(grouped).toContain('data-subagent-group="folded"')
    expect(grouped).toContain('aria-expanded="false"')
    expect(grouped).not.toContain('data-subagent="')
    // The providers they run on, each once.
    expect(grouped).toContain('title="Claude"')

    const split = render([a, { type: 'text', id: 'between', text: 'meanwhile' }, b])
    expect(split).not.toContain('role="group"')
    expect(split.match(/data-subagent="/g)).toHaveLength(2)
  })

  it('opens a group into a card per subagent', () => {
    const parts = ['a', 'b', 'c'].map((id) =>
      subagentPart(subagent({ subagentId: id, title: `Agent ${id}` })),
    )
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <SubagentGroup parts={parts} defaultOpen />
      </ThemeProvider>,
    )
    expect(html).toContain('data-subagent-group="open"')
    expect(html).toContain('aria-expanded="true"')
    expect(html.match(/data-subagent="/g)).toHaveLength(3)
  })

  it('keeps subagents in a settled turn’s work, where they ran, and sums them up above the answer', () => {
    const card = subagentPart(subagent({ status: 'completed' }))
    const parts = [
      { type: 'tool', id: 'read-1', tool: 'Read', state: { status: 'completed' } },
      card,
      { type: 'tool', id: 'read-2', tool: 'Read', state: { status: 'completed' } },
      { type: 'text', id: 'answer', text: 'Done.' },
    ]
    const { workParts, finalParts } = partitionSettledTurnParts(parts)
    expect(workParts.map((part) => part.id)).toEqual(['read-1', card.id, 'read-2'])
    expect(finalParts.map((part) => part.id)).toEqual([card.id, 'answer'])
  })

  it('finds the answer before a card an older environment could not place', () => {
    const card = subagentPart(subagent({ status: 'completed' }))
    const parts = [
      { type: 'tool', id: 'read-1', tool: 'Read', state: { status: 'completed' } },
      { type: 'text', id: 'answer', text: 'Done.' },
      card,
    ]
    const { workParts, finalParts } = partitionSettledTurnParts(parts)
    expect(workParts.map((part) => part.id)).toEqual(['read-1', card.id])
    expect(finalParts.map((part) => part.id)).toEqual([card.id, 'answer'])
  })
})
