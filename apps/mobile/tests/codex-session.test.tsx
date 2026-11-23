// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Subagent } from '@openmanager/protocol'
import { createMockEnvironmentClient, MOCK_CODEX_PROVIDER } from '@openmanager/environment-client'
import {
  EnvironmentClientProvider,
  operationPromptView,
  projectThread,
  subagentPart,
  subagentsNoticeLine,
  EMPTY_THREAD_PROJECTION,
  type MessagePart,
} from '@openmanager/app-core/logic'

import { foldSettledTurn } from '../src/components/parts/work-groups'
import { createFixtureThread } from '../src/session/fixture-thread'
import {
  codexThread,
  delegatedThread,
  FIXTURE_TASKS,
  CODEX_THREAD_SESSION_ID,
} from '../src/session/fixture-threads'
import { resolveThreadRow, threadRowsOf } from '../src/session/thread-rows'

// A Codex session on the phone, as web draws it since #330–#344: the user
// rows nobody typed as a prompt, a review's markers and findings, message
// phases deciding the answer, and subagent cards a reader can stop. Drawn on
// react-native-web.
vi.mock('react-native', async () => {
  // @ts-expect-error -- react-native-web ships no types; it stands in for react-native here.
  return (await import('react-native-web')) as Record<string, unknown>
})
vi.mock('react-native-svg', () => ({ default: () => <i data-svg />, Path: () => null }))
vi.mock('expo-linear-gradient', () => ({ LinearGradient: () => null }))
vi.mock('expo-haptics', () => ({ selectionAsync: async () => undefined }))
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
  chain.delay = () => chain
  return {
    default: { View: web.View, Text: web.Text },
    FadeIn: chain,
    FadeOut: chain,
    LinearTransition: chain,
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
  const names = [
    'ArrowBendDownRightIcon',
    'ArrowClockwiseIcon',
    'ArrowUpIcon',
    'ArrowsInLineVerticalIcon',
    'ArrowsLeftRightIcon',
    'CaretLeftIcon',
    'CaretRightIcon',
    'ChatIcon',
    'CheckIcon',
    'ClockIcon',
    'DownloadSimpleIcon',
    'FileMagnifyingGlassIcon',
    'FilePlusIcon',
    'FilmStripIcon',
    'FlowArrowIcon',
    'FolderOpenIcon',
    'GaugeIcon',
    'GearIcon',
    'GlobeIcon',
    'ImageIcon',
    'ImageBrokenIcon',
    'InfoIcon',
    'ListChecksIcon',
    'MagnifyingGlassIcon',
    'NotePencilIcon',
    'OpenAiLogoIcon',
    'PlugsConnectedIcon',
    'ProhibitIcon',
    'RobotIcon',
    'SealCheckIcon',
    'StopIcon',
    'TerminalIcon',
    'TrashIcon',
    'WarningCircleIcon',
    'WarningIcon',
    'WrenchIcon',
  ]
  return Object.fromEntries(names.map((name) => [name, () => <i data-icon={name} />]))
})
// Pictures and videos load through Expo's native modules; here they are named.
vi.mock('../src/components/parts/ImageGroup', () => ({
  ImageGroup: ({ images }: { images: unknown[] }) => <i data-images={images.length} />,
  useTranscriptWidth: () => 360,
}))
vi.mock('../src/components/parts/VideoPart', () => ({ VideoPart: () => <i data-video /> }))
// What each pressable offers a screen reader, by test id: react-native-web
// leaves accessibility actions out of the DOM.
const accessible = new Map<
  string,
  { actions?: unknown; onAction?: (event: { nativeEvent: { actionName: string } }) => void }
>()
vi.mock('../src/ui/Press', async () => {
  const actual = await vi.importActual<typeof import('../src/ui/Press')>('../src/ui/Press')
  return {
    ...actual,
    Press: ({
      accessibilityActions,
      onAccessibilityAction,
      ...props
    }: Parameters<typeof actual.Press>[0]) => {
      if (props.testID) {
        accessible.set(props.testID, {
          actions: accessibilityActions,
          onAction: onAccessibilityAction as never,
        })
      }
      return <actual.Press {...props} />
    },
  }
})
// The markdown renderer is the text part's own business; here it is the words.
vi.mock('../src/components/parts/TextPart', () => ({
  TextPart: ({ text }: { text: string }) => <p>{text}</p>,
}))

const { StopSubagentContext, SubagentCard } = await import('../src/components/parts/SubagentCard')
const { DelegatedPrompt, DelegatingAgentContext, OperationPrompt, SubagentsFinishedNotice } =
  await import('../src/components/chat/TurnOriginRows')
const { FindingsCard } = await import('../src/components/parts/FindingsCard')
const { TurnNoticeRow } = await import('../src/components/parts/TurnNoticeRow')
const { MessageParts } = await import('../src/components/parts/MessageParts')
const { UsageSection } = await import('../src/settings/UsageSection')

let container: HTMLDivElement
let root: Root
const render = async (node: ReactNode) => {
  await act(async () => root.render(node))
}
const text = () => container.textContent ?? ''
const buttons = () => [...container.querySelectorAll<HTMLElement>('[role="button"]')]
const icons = () =>
  [...container.querySelectorAll<HTMLElement>('[data-icon]')].map((icon) => icon.dataset.icon)

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

const NOW = Date.parse('2026-11-23T10:00:00.000Z')

/** The fixture's rows as the phone resolves them, by the user text or answer they carry. */
function rowsOf(thread = codexThread(NOW)) {
  const fixture = createFixtureThread(thread)
  return threadRowsOf(fixture.stores, fixture.getMessages())
}

describe('a Codex session, projected', () => {
  it('reads the prompts nobody typed as what they are', () => {
    const users = rowsOf().filter((row) => row.role === 'user')
    expect(users.map((row) => row.origin)).toEqual([
      undefined,
      'subagents',
      'compact',
      'review',
      undefined,
    ])
    const delegated = rowsOf(delegatedThread(NOW)).find((row) => row.role === 'user')
    expect(delegated?.origin).toBe('delegated')
  })

  it('takes the final answer as the answer and folds commentary into the work', () => {
    const projection = projectThread(codexThread(NOW), EMPTY_THREAD_PROJECTION)
    const first = projection.messages.find((message) => message.role === 'assistant')!
    const row = resolveThreadRow(first, projection.byId.get(first.externalId)?.content, undefined)!
    const fold = foldSettledTurn(row.parts)
    const answerText = fold.answer
      .filter((part) => part.type === 'text')
      .map((part) => part.text as string)
    expect(answerText).toHaveLength(1)
    expect(answerText[0]).toContain('The cards flashed because')
    const workText = fold.work.filter((part) => part.type === 'text').map((part) => part.phase)
    expect(workText).toEqual(['commentary', 'commentary'])
    // The subagents head the answer, and both images the turn made are in it.
    expect(fold.answer.filter((part) => part.type === 'subagent')).toHaveLength(2)
    expect(fold.answer.filter((part) => part.type === 'image')).toHaveLength(2)
  })

  it('marks what a review found after its finished marker', () => {
    const projection = projectThread(codexThread(NOW), EMPTY_THREAD_PROJECTION)
    const parts = projection.messages
      .map((message) => projection.byId.get(message.externalId)?.content?.parts ?? [])
      .flat() as MessagePart[]
    const findings = parts.filter((part) => part.type === 'text' && part.findings === true)
    expect(findings).toHaveLength(1)
    expect(findings[0]!.text).toContain('The skeleton hides a failed read')
  })

  it('keeps the terminal the live turn left running', () => {
    expect(FIXTURE_TASKS[CODEX_THREAD_SESSION_ID]).toEqual([
      expect.objectContaining({ kind: 'shell' }),
    ])
  })
})

describe('turn origin words', () => {
  it('says what an operation ran, with the command as typed', () => {
    expect(operationPromptView('/review base main', 'review')).toEqual({
      label: 'Code review',
      detail: 'changes against main',
      command: '/review',
    })
    expect(operationPromptView('/compact', 'compact')).toEqual({
      label: 'Compact the conversation',
      command: '/compact',
    })
  })

  it('heads a subagents notice with its first line, without the tag', () => {
    expect(
      subagentsNoticeLine(
        '<subagents-finished>\nSubagents finished:\n- a: done\n</subagents-finished>',
      ),
    ).toEqual({ title: 'Subagents finished', more: true })
  })
})

describe('turn origin rows', () => {
  it('draws an operation as one line, not a bubble', async () => {
    await render(<OperationPrompt content="/review base main" origin="review" />)
    expect(text()).toContain('Code review')
    expect(text()).toContain('changes against main')
    expect(text()).toContain('/review')
    expect(icons()).toContain('MagnifyingGlassIcon')
  })

  it('opens a subagents notice to what the agent was told', async () => {
    await render(
      <SubagentsFinishedNotice
        content={
          '<subagents-finished>\nSubagents finished:\n- explorer: done\n</subagents-finished>'
        }
      />,
    )
    expect(text()).toBe('Subagents finished')
    await act(async () => buttons()[0]!.click())
    expect(text()).toContain('explorer: done')
  })

  it('names who gave a delegated brief, and opens the parent', async () => {
    const onOpen = vi.fn()
    await render(
      <DelegatingAgentContext.Provider
        value={{ providerId: 'claude', sessionTitle: 'Tool call payloads', onOpen }}
      >
        <DelegatedPrompt content="Write the contract tests." />
      </DelegatingAgentContext.Provider>,
    )
    expect(text()).toContain('Prompt from Claude')
    expect(text()).toContain('Write the contract tests.')
    const parent = container.querySelector<HTMLElement>('[role="link"]')!
    await act(async () => parent.click())
    expect(onOpen).toHaveBeenCalledOnce()
  })

  it('folds a long brief until asked', async () => {
    await render(<DelegatedPrompt content={'x'.repeat(700)} />)
    expect(text()).toContain('Prompt from the parent agent')
    expect(text()).toContain('Show the whole prompt')
    await act(async () => buttons()[0]!.click())
    expect(text()).toContain('Show less')
  })
})

describe('review rows', () => {
  it('shows the findings on their own card', async () => {
    await render(<FindingsCard text="**1.** A failed read hangs." />)
    expect(text()).toContain('Findings')
    expect(text()).toContain('A failed read hangs.')
  })

  it('routes a findings part to the card', async () => {
    await render(
      <MessageParts
        parts={[{ type: 'text', id: 'f', text: 'One finding.', findings: true }]}
        isStreaming={false}
      />,
    )
    expect(text()).toContain('Findings')
  })

  it('marks a review starting and finishing with their own glyphs', async () => {
    await render(
      <TurnNoticeRow
        notice={{
          noticeId: 'n-1',
          turnId: 'turn-1',
          kind: 'info',
          message: 'Review started',
          review: { phase: 'started', target: 'changes against main' },
        }}
      />,
    )
    expect(text()).toContain('Review started')
    expect(text()).toContain('changes against main')
    expect(icons()).toContain('MagnifyingGlassIcon')
    await render(
      <TurnNoticeRow
        notice={{
          noticeId: 'n-2',
          turnId: 'turn-1',
          kind: 'info',
          message: 'Review finished',
          review: { phase: 'finished' },
        }}
      />,
    )
    expect(icons()).toContain('SealCheckIcon')
  })

  it('reads an answered question as the exchange it was', async () => {
    await render(
      <MessageParts
        parts={[
          {
            type: 'tool',
            id: 'q',
            tool: 'AskUserQuestion',
            toolName: 'AskUserQuestion',
            state: {
              status: 'completed',
              input: {
                questions: [{ question: 'Which theme first?' }],
                answers: { 'Which theme first?': 'Dark' },
              },
            },
          },
        ]}
        isStreaming={false}
      />,
    )
    expect(text()).toContain('Which theme first?')
    expect(text()).toContain('Dark')
  })
})

const codexSubagent = (patch: Partial<Subagent> = {}): Subagent => ({
  subagentId: 'sub-1',
  parentSessionId: 'parent',
  turnId: 'turn-1',
  toolCallId: 'call-sub-1',
  depth: 1,
  origin: 'native',
  providerId: 'codex',
  modelId: 'gpt-5.5',
  title: 'theme-checker',
  status: 'running',
  background: false,
  promptable: false,
  stoppable: true,
  stats: {},
  startedAt: new Date(Date.now() - 5_000).toISOString(),
  updatedAt: new Date().toISOString(),
  ...patch,
})

describe('subagent cards', () => {
  it('offers Stop on a live one the environment can stop, and sends it', async () => {
    let finish: () => void = () => undefined
    const stop = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)))
    const subagent = codexSubagent()
    await render(
      <StopSubagentContext.Provider value={stop}>
        <SubagentCard part={subagentPart(subagent)} />
      </StopSubagentContext.Provider>,
    )
    const button = container.querySelector<HTMLElement>('[data-testid="subagent-stop"]')!
    expect(button.textContent).toBe('Stop')
    await act(async () => button.click())
    expect(stop).toHaveBeenCalledWith(subagent)
    expect(button.textContent).toContain('Stopping')
    await act(async () => finish())
  })

  it('says a refused stop and lets the reader try again', async () => {
    const stop = vi.fn(async () => {
      throw new Error('It already finished')
    })
    await render(
      <StopSubagentContext.Provider value={stop}>
        <SubagentCard part={subagentPart(codexSubagent())} />
      </StopSubagentContext.Provider>,
    )
    const button = container.querySelector<HTMLElement>('[data-testid="subagent-stop"]')!
    await act(async () => button.click())
    expect(button.textContent).toBe('Try again')
    // The reason is on screen, under the card, not only in the label.
    const reason = container.querySelector<HTMLElement>('[data-testid="subagent-stop-failure"]')
    expect(reason?.textContent).toBe('Couldn’t stop it: It already finished')
    // Trying again clears it while the stop runs.
    await act(async () =>
      container.querySelector<HTMLElement>('[data-testid="subagent-stop"]')!.click(),
    )
    expect(stop).toHaveBeenCalledTimes(2)
  })

  it('offers Stop to a screen reader as an action of the card', async () => {
    const stop = vi.fn(() => new Promise<void>(() => undefined))
    const subagent = codexSubagent({ subagentId: 'sub-a11y' })
    await render(
      <StopSubagentContext.Provider value={stop}>
        <SubagentCard part={subagentPart(subagent)} />
      </StopSubagentContext.Provider>,
    )
    const card = accessible.get('subagent:sub-a11y')!
    expect(card.actions).toEqual([{ name: 'stop', label: 'Stop theme-checker' }])
    await act(async () => card.onAction!({ nativeEvent: { actionName: 'stop' } }))
    expect(stop).toHaveBeenCalledWith(subagent)
    // While it stops, there is nothing more to offer.
    expect(accessible.get('subagent:sub-a11y')!.actions).toBeUndefined()
  })

  it('offers no Stop on a settled one, or where the page cannot stop it', async () => {
    await render(
      <StopSubagentContext.Provider value={vi.fn(async () => undefined)}>
        <SubagentCard part={subagentPart(codexSubagent({ status: 'completed' }))} />
      </StopSubagentContext.Provider>,
    )
    expect(container.querySelector('[data-testid="subagent-stop"]')).toBeNull()
    await render(<SubagentCard part={subagentPart(codexSubagent({ subagentId: 'sub-2' }))} />)
    expect(container.querySelector('[data-testid="subagent-stop"]')).toBeNull()
  })

  it('shows what it runs on as the provider mark, and a waiting status in words', async () => {
    await render(
      <SubagentCard
        part={subagentPart(codexSubagent({ subagentId: 'sub-3', status: 'waiting' }))}
      />,
    )
    expect(icons()).toContain('OpenAiLogoIcon')
    expect(text()).toContain('Needs permission')
  })
})

describe('usage limits in settings', () => {
  it('shows a provider plan, its windows and its credits, and asks for a fresh reading', async () => {
    const at = new Date(Date.now() - 2 * 60_000).toISOString()
    const client = createMockEnvironmentClient({
      seed: {
        providers: [
          {
            ...MOCK_CODEX_PROVIDER,
            limits: {
              supported: true,
              refreshing: false,
              lastRefresh: { outcome: 'ok', at },
              reading: {
                windows: [
                  {
                    id: 'five_hour',
                    label: '5-hour limit',
                    group: 'session',
                    usedPercent: 42,
                    resetsAt: new Date(Date.now() + 90 * 60_000).toISOString(),
                    status: null,
                  },
                  {
                    id: 'seven_day',
                    label: 'Weekly limit',
                    group: 'weekly',
                    usedPercent: 93,
                    resetsAt: null,
                    status: null,
                  },
                ],
                extraUsage: null,
                plan: 'Plus',
                credits: { hasCredits: true, unlimited: false, balance: '120' },
                at,
              },
            },
          },
        ],
      },
    })
    await act(() => client.connect())
    const refresh = vi.spyOn(client.commands, 'refreshProviderLimits')
    await render(
      <EnvironmentClientProvider client={client}>
        <UsageSection />
      </EnvironmentClientProvider>,
    )
    expect(text()).toContain('Plus plan')
    expect(text()).toContain('Updated 2m ago')
    expect(text()).toContain('5-hour limit')
    expect(text()).toContain('42%')
    expect(text()).toContain('Almost out')
    expect(text()).toContain('Credits')
    expect(text()).toContain('120 left')
    expect(icons()).toContain('OpenAiLogoIcon')
    expect(refresh).toHaveBeenCalledWith({ providerId: 'codex', maxAgeMs: 60_000 })
  })
})
