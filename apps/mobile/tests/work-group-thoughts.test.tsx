// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Subagent } from '@openmanager/protocol'
import { groupActivityParts } from '@openmanager/shared/lib/activity-groups'
import { subagentPart, type MessagePart } from '@openmanager/app-core/logic'

import type { HomeSession } from '../src/home/rows'
import { childSessionsWithoutCards } from '../src/session/child-sessions'
import { foldSettledTurn, liveThoughtOf } from '../src/components/parts/work-groups'

// Thoughts folded into work groups and subagent cards where they ran, as the
// phone draws them on react-native-web: web's #323 on the phone.
vi.mock('react-native', async () => {
  // @ts-expect-error -- react-native-web ships no types; it stands in for react-native here.
  return (await import('react-native-web')) as Record<string, unknown>
})
vi.mock('react-native-svg', () => ({ default: () => <i data-svg />, Path: () => null }))
vi.mock('expo-haptics', () => ({ impactAsync: () => undefined, ImpactFeedbackStyle: {} }))
vi.mock('../src/theme/ThemeProvider', () => {
  const ink: Record<string, unknown> = new Proxy({}, { get: () => '#888888' })
  const theme = new Proxy(
    {},
    {
      get: (_target, key) =>
        key === 'status' || key === 'statusInk' || key === 'statusWash'
          ? ink
          : key === 'wash'
            ? () => '#88888822'
            : '#888888',
    },
  )
  return { usePhoneTheme: () => theme }
})
vi.mock('react-native-reanimated', async () => {
  // @ts-expect-error -- react-native-web ships no types.
  const web = (await import('react-native-web')) as { View: unknown; Text: unknown }
  const chain: Record<string, unknown> = {}
  chain.duration = () => chain
  chain.easing = () => chain
  return {
    default: { View: web.View, Text: web.Text },
    FadeIn: chain,
    Easing: {
      out: (curve: unknown) => curve,
      inOut: (curve: unknown) => curve,
      quad: 'quad',
      linear: 'linear',
    },
    useSharedValue: (value: number) => ({ value }),
    useAnimatedStyle: (style: () => object) => style(),
    withTiming: (value: number) => value,
    withRepeat: (value: number) => value,
    cancelAnimation: () => undefined,
  }
})
vi.mock('phosphor-react-native', () => {
  const names = ['CaretRightIcon', 'CheckIcon', 'OpenAiLogoIcon', 'StopIcon']
  return Object.fromEntries(names.map((name) => [name, () => <i data-icon={name} />]))
})

const { WorkGroup } = await import('../src/components/parts/WorkGroup')
const { liveThoughtTail } = await import('../src/components/parts/ThinkingPart')
const { OpenChildSessionContext, SubagentCard, SubagentGroup } =
  await import('../src/components/parts/SubagentCard')

let container: HTMLDivElement
let root: Root
const render = async (node: ReactNode) => {
  await act(async () => root.render(node))
}
const text = () => container.textContent ?? ''
const buttons = () => [...container.querySelectorAll<HTMLElement>('[role="button"]')]
const press = async (element: HTMLElement) => {
  await act(async () => element.click())
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const tool = (id: string, status = 'completed'): MessagePart => ({
  type: 'tool',
  id,
  callID: id,
  tool: 'Read',
  toolName: 'Read',
  kind: 'read',
  state: { status, input: { file_path: `${id}.ts` } },
})
const thought = (id: string, done: boolean): MessagePart => ({
  type: 'reasoning',
  id,
  text: 'Weighing the two places the card could go.',
  time: done ? { start: 1, end: 2 } : { start: 1 },
})
const answer = (id: string): MessagePart => ({ type: 'text', id, text: 'Done.' })

const subagent = (id: string, patch: Partial<Subagent> = {}): Subagent => ({
  subagentId: id,
  parentSessionId: 'parent',
  turnId: 'turn-1',
  toolCallId: `call-${id}`,
  depth: 1,
  origin: 'native',
  providerId: 'claude',
  title: `Explore ${id}`,
  agentType: 'Explore',
  status: 'completed',
  background: false,
  childSessionId: `child-${id}`,
  promptable: false,
  stoppable: false,
  stats: { durationMs: 12_000 },
  startedAt: '2026-11-19T10:00:00.000Z',
  updatedAt: '2026-11-19T10:00:12.000Z',
  ...patch,
})

describe('thoughts in work groups', () => {
  it('folds the thoughts between calls into the run, and hangs a live last one on its branch', () => {
    const live = thought('r2', false)
    const nodes = groupActivityParts(
      [thought('r1', true), tool('t1'), tool('t2'), live] as MessagePart[],
      { absorbReasoning: true },
    )
    expect(nodes).toHaveLength(1)
    const group = nodes[0]!
    if (group.kind !== 'group') throw new Error('expected a group')
    expect(group.items).toHaveLength(4)
    expect(group.summary).toMatchObject({ toolCount: 2, thoughtCount: 2, isRunning: false })
    expect(liveThoughtOf(group.items, group.summary.toolCount, true)).toBe(live)
  })

  it('reads a thought the work moved past, or one that ended, as had', () => {
    const items = [tool('t1'), thought('r1', false), tool('t2')]
    expect(liveThoughtOf(items, 2, true)).toBeUndefined()
    expect(liveThoughtOf([tool('t1'), thought('r1', true)], 1, true)).toBeUndefined()
  })

  it('keeps a run of thoughts alone out of any group', () => {
    const items = [thought('r1', false)]
    expect(liveThoughtOf(items, 0, true)).toBeUndefined()
    const nodes = groupActivityParts([...items, answer('a1')], { absorbReasoning: true })
    expect(nodes[0]).toMatchObject({ kind: 'group', summary: { toolCount: 0 } })
  })

  it('shows the live thought under a folded group, and its place among the calls once opened', async () => {
    await render(
      <WorkGroup label="Explored 2 files" meta="2 tool calls" live={<span>Thinking now</span>}>
        <span>row one</span>
      </WorkGroup>,
    )
    expect(text()).toContain('Thinking now')
    expect(text()).not.toContain('row one')
    await press(buttons()[0]!)
    expect(text()).toContain('row one')
    expect(text()).not.toContain('Thinking now')
  })

  it('streams the end of a long thought, from the start of a word', () => {
    expect(liveThoughtTail('  short  ')).toBe('short')
    const long = `${'alpha '.repeat(60)}omega`
    const tail = liveThoughtTail(long, 40)
    expect(tail.startsWith('…')).toBe(true)
    expect(tail.endsWith('omega')).toBe(true)
    expect(tail.length).toBeLessThanOrEqual(41)
    expect(tail[1]).toBe('a')
  })
})

describe('subagent cards', () => {
  it('keeps a subagent where it ran and heads the answer with it once the turn settles', () => {
    const card = subagentPart(subagent('s1'))
    const fold = foldSettledTurn([
      tool('t1'),
      card as unknown as MessagePart,
      tool('t2'),
      answer('a1'),
    ])
    expect(fold.work.map((part) => part.id)).toEqual(['t1', card.id, 't2'])
    expect(fold.answer.map((part) => part.id)).toEqual([card.id, 'a1'])
    expect(fold.toolCount).toBe(2)
  })

  it('opens its child session from the card', async () => {
    const open = vi.fn()
    await render(
      <OpenChildSessionContext.Provider value={open}>
        <SubagentCard part={subagentPart(subagent('s1'))} />
      </OpenChildSessionContext.Provider>,
    )
    expect(text()).toContain('Explore s1')
    expect(text()).toContain('12s')
    await press(buttons()[0]!)
    expect(open).toHaveBeenCalledWith('child-s1')
  })

  it('is not a button with nowhere to go', async () => {
    await render(
      <OpenChildSessionContext.Provider value={vi.fn()}>
        <SubagentCard part={subagentPart(subagent('s1', { childSessionId: undefined }))} />
      </OpenChildSessionContext.Provider>,
    )
    expect(buttons()).toHaveLength(0)
  })

  it('says how a stopped or waiting one stands', async () => {
    await render(
      <>
        <SubagentCard part={subagentPart(subagent('s1', { status: 'cancelled' }))} />
        <SubagentCard
          part={subagentPart(subagent('s2', { status: 'waiting', waitingOn: 'question' }))}
        />
      </>,
    )
    expect(text()).toContain('Stopped')
    expect(text()).toContain('Has a question')
  })

  it('folds subagents started back to back into one group, a card each when opened', async () => {
    await render(
      <SubagentGroup
        parts={[
          subagentPart(subagent('s1')),
          subagentPart(subagent('s2', { status: 'running', stats: {} })),
        ]}
      />,
    )
    expect(text()).toContain('2 subagents')
    expect(text()).toContain('1 working, 1 done')
    expect(text()).not.toContain('Explore s1')
    await press(buttons()[0]!)
    expect(text()).toContain('Explore s1')
    expect(text()).toContain('Explore s2')
  })

  it('lists at the end only the children no card opens', () => {
    const row = (externalId: string) => ({ externalId }) as HomeSession
    const children = [row('child-s1'), row('older')]
    expect(childSessionsWithoutCards(children, [subagent('s1')]).map((c) => c.externalId)).toEqual([
      'older',
    ])
    expect(childSessionsWithoutCards(children, [])).toBe(children)
  })
})
