// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ALL_DONE_LINGER_MS, type LineageSession } from '@openmanager/app-core/logic'
import type { Subagent } from '@openmanager/protocol'

import { lineageReader, type LineageState } from '../src/session/subagent-lineage'
import { createFixtureThread } from '../src/session/fixture-thread'
import { FIXTURE_LINEAGE, workingThread } from '../src/session/fixture-threads'

// The chat's live subagents above the phone's composer (web's SubagentDock),
// drawn on react-native-web.
vi.mock('react-native', async () => {
  // @ts-expect-error -- react-native-web ships no types; it stands in for react-native here.
  return (await import('react-native-web')) as Record<string, unknown>
})
vi.mock('react-native-svg', () => ({ default: () => <i data-svg />, Path: () => null }))
vi.mock('expo-haptics', () => ({ impactAsync: () => undefined, ImpactFeedbackStyle: {} }))
vi.mock('../src/ui/Glass', () => ({
  Glass: ({ children }: { children: ReactNode }) => <div data-glass>{children}</div>,
}))
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
    FadeOut: chain,
    LinearTransition: chain,
    Easing: {
      in: (curve: unknown) => curve,
      out: (curve: unknown) => curve,
      inOut: (curve: unknown) => curve,
      quad: 'quad',
      cubic: 'cubic',
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
  const names = ['CaretDownIcon', 'CaretRightIcon', 'CheckIcon', 'SquareIcon', 'StopIcon']
  return Object.fromEntries(names.map((name) => [name, () => <i data-icon={name} />]))
})

const { SubagentStrip } = await import('../src/session/SubagentStrip')
const { OpenChildSessionContext, StopSubagentContext } =
  await import('../src/components/parts/SubagentCard')

const record = (id: string, patch: Partial<Subagent> = {}): Subagent => ({
  subagentId: id,
  parentSessionId: 'root',
  turnId: 'turn-1',
  depth: 1,
  origin: 'native',
  providerId: 'claude',
  title: `Explore ${id}`,
  status: 'running',
  background: true,
  childSessionId: `child-${id}`,
  promptable: false,
  stoppable: true,
  stats: {},
  startedAt: '2026-11-19T10:00:00.000Z',
  updatedAt: '2026-11-19T10:00:00.000Z',
  ...patch,
})

const childSession = (
  id: string,
  parent: string,
  patch: Partial<LineageSession> = {},
): LineageSession => ({
  sessionId: id,
  title: id,
  status: 'running',
  providerId: 'claude',
  parentSessionId: parent,
  subagent: { subagentId: id.replace('child-', ''), origin: 'native', promptable: false },
  ...patch,
})

/** A small store standing in for the environment client's state. */
function store(initial: LineageState) {
  let state = initial
  const listeners = new Set<() => void>()
  return {
    getState: () => state,
    set(next: Partial<LineageState>) {
      state = { ...state, ...next }
      for (const listener of [...listeners]) listener()
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
  }
}

const rootSession: LineageSession = {
  sessionId: 'root',
  title: 'Root',
  status: 'running',
  providerId: 'claude',
  threadIds: ['root-thread'],
}

let container: HTMLDivElement
let root: Root
const render = async (node: ReactNode) => {
  await act(async () => root.render(node))
}
const text = () => container.textContent ?? ''
const byTestId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`)
const press = async (element: HTMLElement | null) => {
  if (!element) throw new Error('nothing to press')
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
  vi.useRealTimers()
})

describe('the lineage reader', () => {
  it('hands back the same lineage while what it draws is the same', () => {
    const subagents = [record('a', { activity: 'Reading auth.ts' })]
    const env = store({
      sessions: { root: rootSession, 'child-a': childSession('child-a', 'root') },
      threads: { 'root-thread': { subagents } },
    })
    const read = lineageReader(env.getState, 'root')
    const first = read()
    expect(first.live.map((node) => node.key)).toEqual(['a'])
    // A streamed token: a new thread object, the same subagents.
    env.set({ threads: { 'root-thread': { subagents } } })
    expect(read()).toBe(first)
    // A fresh sessions map that lists the same: still the same lineage.
    env.set({ sessions: { ...env.getState().sessions } })
    expect(read()).toBe(first)
    // What it does changes: a new one.
    env.set({ threads: { 'root-thread': { subagents: [record('a', { activity: 'Editing' })] } } })
    expect(read()).not.toBe(first)
    expect(read().roots[0]!.subagent?.activity).toBe('Editing')
  })
})

describe('the subagent strip', () => {
  it('says nothing while no subagent works', async () => {
    const env = store({ sessions: { root: rootSession }, threads: {} })
    await render(
      <SubagentStrip subscribe={env.subscribe} getLineage={lineageReader(env.getState, 'root')} />,
    )
    expect(byTestId('subagent-strip')).toBeNull()
  })

  it('folds to how many work and need you, and opens to the tree, nested at any depth', async () => {
    const env = store({
      sessions: {
        root: rootSession,
        'child-a': childSession('child-a', 'root'),
        'child-b': childSession('child-b', 'root', { status: 'idle' }),
        // b's own subagent, still waiting on a permission: b stays, as the way to it.
        'child-b1': childSession('child-b1', 'child-b', {
          status: 'waiting',
          waitingOn: 'permission',
          title: 'Record fixtures',
          providerId: 'codex',
        }),
      },
      threads: {
        'root-thread': {
          subagents: [
            record('a', { activity: 'Reading **auth.ts**' }),
            record('b', { status: 'completed', title: 'Map callers' }),
          ],
        },
      },
    })
    await render(
      <SubagentStrip subscribe={env.subscribe} getLineage={lineageReader(env.getState, 'root')} />,
    )
    expect(text()).toContain('Subagents · 1 working · 1 needs you')
    expect(byTestId('subagent-strip-list')).toBeNull()

    await press(byTestId('subagent-strip-toggle'))
    const rows = [...container.querySelectorAll('[data-testid^="subagent-strip-row:"]')].map(
      (row) => row.getAttribute('data-testid')!.slice('subagent-strip-row:'.length),
    )
    expect(rows).toEqual(['a', 'b', 'b1'])
    expect(text()).toContain('Reading auth.ts')
    expect(text()).toContain('Waiting for your permission')
    expect(text()).toContain('Record fixtures')
  })

  it('opens a row’s session and stops a live one', async () => {
    const env = store({
      sessions: { root: rootSession, 'child-a': childSession('child-a', 'root') },
      threads: { 'root-thread': { subagents: [record('a')] } },
    })
    const open = vi.fn()
    const stop = vi.fn(async () => undefined)
    await render(
      <OpenChildSessionContext.Provider value={open}>
        <StopSubagentContext.Provider value={stop}>
          <SubagentStrip
            subscribe={env.subscribe}
            getLineage={lineageReader(env.getState, 'root')}
            defaultOpen
          />
        </StopSubagentContext.Provider>
      </OpenChildSessionContext.Provider>,
    )
    await press(byTestId('subagent-strip-open:a'))
    expect(open).toHaveBeenCalledWith('child-a')
    await press(byTestId('subagent-strip-stop'))
    expect(stop).toHaveBeenCalledWith(expect.objectContaining({ subagentId: 'a' }))
  })

  it('says "All N done" once the last finishes, then fades', async () => {
    vi.useFakeTimers()
    const env = store({
      sessions: {
        root: rootSession,
        'child-a': childSession('child-a', 'root'),
        'child-b': childSession('child-b', 'root'),
      },
      threads: { 'root-thread': { subagents: [record('a'), record('b')] } },
    })
    await render(
      <SubagentStrip subscribe={env.subscribe} getLineage={lineageReader(env.getState, 'root')} />,
    )
    expect(text()).toContain('2 working')
    await act(async () =>
      env.set({
        sessions: {
          root: rootSession,
          'child-a': childSession('child-a', 'root', { status: 'idle' }),
          'child-b': childSession('child-b', 'root', { status: 'idle' }),
        },
        threads: {
          'root-thread': {
            subagents: [record('a', { status: 'completed' }), record('b', { status: 'completed' })],
          },
        },
      }),
    )
    expect(text()).toContain('All 2 done')
    await act(async () => vi.advanceTimersByTime(ALL_DONE_LINGER_MS - 100))
    expect(text()).toContain('All 2 done')
    await act(async () => vi.advanceTimersByTime(200))
    expect(byTestId('subagent-strip')).toBeNull()
  })

  it('shows the sample chat’s subagents, nested, without a server', async () => {
    const fixture = createFixtureThread(
      workingThread(Date.now()),
      [],
      FIXTURE_LINEAGE['s-tool-payloads'],
    )
    await render(
      <SubagentStrip subscribe={fixture.subscribe} getLineage={fixture.getLineage} defaultOpen />,
    )
    expect(text()).toContain('1 working · 1 needs you')
    expect(text()).toContain('Contract tests for turn_activity')
    expect(text()).toContain('Record Cursor fixtures')
    const nested = fixture.getLineage().all.find((node) => node.key === 'nested-cursor')
    expect(nested).toMatchObject({ depth: 2, tone: 'waiting', sessionId: 's-tool-payloads-cursor' })
  })
})
