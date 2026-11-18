// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Subagent } from '@openmanager/protocol'
import { ThemeProvider } from '../../providers/theme-provider'
import { MessageParts } from './MessageParts'
import { partitionSettledTurnParts } from './turn-work-group'
import {
  formatElapsed,
  formatTokens,
  resultPreview,
  subagentElapsedMs,
  subagentGroupSummary,
  subagentModelLabel,
  subagentName,
  subagentPart,
  subagentStatsLine,
  subagentStatusLabel,
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

  it('formats time, tokens and the stats line compactly', () => {
    expect(formatElapsed(8_400)).toBe('8s')
    expect(formatElapsed(72_000)).toBe('1m 12s')
    expect(formatElapsed(120_000)).toBe('2m')
    expect(formatElapsed(3_840_000)).toBe('1h 4m')
    expect(formatTokens(940)).toBe('940')
    expect(formatTokens(12_000)).toBe('12k')
    expect(formatTokens(31_420)).toBe('31.4k')
    expect(formatTokens(188_000)).toBe('188k')
    expect(formatTokens(1_200_000)).toBe('1.2M')
    expect(subagentStatsLine({ toolCalls: 1, tokens: 31_420 })).toBe('1 tool · 31.4k tokens')
    expect(subagentStatsLine({})).toBe('')
  })

  it('names the status, what a waiting one waits on, and the subagent itself', () => {
    expect(subagentStatusLabel({ status: 'waiting', waitingOn: 'question' })).toBe('Has a question')
    expect(subagentStatusLabel({ status: 'waiting', waitingOn: 'permission' })).toBe(
      'Needs permission',
    )
    expect(subagentStatusLabel({ status: 'cancelled' })).toBe('Stopped')
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
    ).toEqual({ title: '4 subagents', detail: '1 waiting, 1 running, 2 done', running: true })
    expect(subagentGroupSummary([{ status: 'completed' }, { status: 'failed' }]).running).toBe(
      false,
    )
  })

  it('previews a markdown result as one plain paragraph', () => {
    expect(resultPreview('Found **7 callers**.\n\n- `auth.ts`\n```ts\ncode\n```\nDone')).toBe(
      'Found 7 callers. auth.ts Done',
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
  it('shows a lone subagent as a card with what it is doing', () => {
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
    expect(html).toContain('Background')
    expect(html).toContain('Reading auth.ts')
    expect(html).toContain('claude-haiku-4-5 · 3 tools · 4.1k tokens')
    expect(html).not.toContain('role="group"')
    // No environment to ask: no Stop, and no child to open.
    expect(html).not.toContain('Stop')
  })

  it('flags a waiting subagent with what it waits on', () => {
    const html = render([subagentPart(subagent({ status: 'waiting', waitingOn: 'question' }))])
    expect(html).toContain('Has a question')
    expect(html).toContain('data-subagent-status="waiting"')
  })

  it('shows a settled one’s result folded, and why a failed one failed', () => {
    const done = render([
      subagentPart(subagent({ status: 'completed', result: 'Found **7** callers.' })),
    ])
    expect(done).toContain('Found 7 callers.')
    expect(done).toContain('Show result')
    const failed = render([
      subagentPart(subagent({ status: 'failed', statusReason: 'Postgres is down' })),
    ])
    expect(failed).toContain('Postgres is down')
    expect(failed).toContain('Failed')
  })

  it('groups subagents started back to back, and only those', () => {
    const a = subagentPart(subagent({ subagentId: 'a', title: 'First' }))
    const b = subagentPart(subagent({ subagentId: 'b', title: 'Second', status: 'completed' }))
    const c = subagentPart(subagent({ subagentId: 'c', title: 'Third' }))
    const grouped = render([a, b, c])
    expect(grouped.match(/role="group"/g)).toHaveLength(1)
    expect(grouped).toContain('3 subagents')
    expect(grouped).toContain('2 running, 1 done')

    const split = render([a, { type: 'text', id: 'between', text: 'meanwhile' }, b])
    expect(split).not.toContain('role="group"')
    expect(split.match(/data-subagent="/g)).toHaveLength(2)
  })

  it('keeps subagents out of a settled turn’s folded work', () => {
    const card = subagentPart(subagent({ status: 'completed' }))
    const parts = [
      { type: 'tool', id: 'read-1', tool: 'Read', state: { status: 'completed' } },
      card,
      { type: 'tool', id: 'read-2', tool: 'Read', state: { status: 'completed' } },
      { type: 'text', id: 'answer', text: 'Done.' },
    ]
    const { workParts, finalParts } = partitionSettledTurnParts(parts)
    expect(workParts.map((part) => part.id)).toEqual(['read-1', 'read-2'])
    expect(finalParts.map((part) => part.id)).toEqual([card.id, 'answer'])
  })
})
