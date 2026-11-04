// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  EnvironmentClientProvider,
  failurePart,
  noticePart,
  projectThread,
  TurnRecoveryContext,
  type TurnRecoveryValue,
} from '@openmanager/app-core/logic'
import type { EnvironmentClient } from '@openmanager/environment-client'

import { getToolIcon } from '../src/components/parts/toolIcons'
import type { ToolPartData } from '../src/components/parts/ToolRow'
import { foldSettledTurn } from '../src/components/parts/work-groups'
import { failedThread } from '../src/session/fixture-threads'

// The v21 rows as the phone draws them, on react-native-web: a tool row read
// from its input with its output fetched when opened, and the notice and
// failure parts the shared projection puts in a turn.
vi.mock('react-native', async () => {
  // @ts-expect-error -- react-native-web ships no types; it stands in for react-native here.
  return (await import('react-native-web')) as Record<string, unknown>
})
vi.mock('../src/theme/ThemeProvider', () => {
  const ink: Record<string, unknown> = new Proxy({}, { get: () => '#888888' })
  const theme = new Proxy(
    {},
    { get: (_target, key) => (key === 'status' || key === 'statusWash' ? ink : '#888888') },
  )
  return { usePhoneTheme: () => theme }
})
// Nothing animates here: the reveal and the chevron's turn read at rest.
vi.mock('react-native-reanimated', async () => {
  // @ts-expect-error -- react-native-web ships no types.
  const web = (await import('react-native-web')) as { View: unknown }
  const chain: Record<string, unknown> = {}
  chain.duration = () => chain
  chain.easing = () => chain
  return {
    default: { View: web.View },
    FadeIn: chain,
    Easing: { out: (curve: unknown) => curve, inOut: (curve: unknown) => curve, quad: 'quad' },
    useSharedValue: (value: number) => ({ value }),
    useAnimatedStyle: (style: () => object) => style(),
    withTiming: (value: number) => value,
    withRepeat: (value: number) => value,
    cancelAnimation: () => undefined,
  }
})
vi.mock('phosphor-react-native', () => {
  const names = [
    'ArrowClockwiseIcon',
    'ArrowsInLineVerticalIcon',
    'ArrowsLeftRightIcon',
    'CaretRightIcon',
    'ChatIcon',
    'DownloadSimpleIcon',
    'FileMagnifyingGlassIcon',
    'FilePlusIcon',
    'FolderOpenIcon',
    'GaugeIcon',
    'GlobeIcon',
    'InfoIcon',
    'ListChecksIcon',
    'MagnifyingGlassIcon',
    'NotePencilIcon',
    'PlugsConnectedIcon',
    'ProhibitIcon',
    'RobotIcon',
    'TerminalIcon',
    'TrashIcon',
    'WarningCircleIcon',
    'WarningIcon',
    'WrenchIcon',
  ]
  return Object.fromEntries(names.map((name) => [name, () => <i data-icon={name} />]))
})

const { ToolRow } = await import('../src/components/parts/ToolRow')
const { TurnFailureRow, TurnNoticeRow } = await import('../src/components/parts/TurnNoticeRow')

let container: HTMLDivElement
let root: Root
const render = async (node: ReactNode) => {
  await act(async () => root.render(node))
}
const text = () => container.textContent ?? ''
const buttons = () => [...container.querySelectorAll<HTMLElement>('[role="button"]')]

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
  vi.restoreAllMocks()
})

const bash = (patch: Partial<ToolPartData>): ToolPartData => ({
  type: 'tool',
  id: 'call-1',
  callID: 'call-1',
  sessionId: 'session-1',
  tool: 'Bash',
  toolName: 'Bash',
  kind: 'execute',
  state: { status: 'completed', input: { command: 'pnpm test' } },
  ...patch,
})

describe('tool rows', () => {
  it('says what a call set out to do and how it ended, from its input alone', async () => {
    await render(
      <ToolRow
        part={bash({ state: { status: 'declined', input: { command: 'rm -rf build' } } })}
      />,
    )
    expect(text()).toContain('rm -rf build')
    expect(text()).toContain('Declined')
    await render(
      <ToolRow part={bash({ state: { status: 'cancelled', input: { command: 'sleep 60' } } })} />,
    )
    expect(text()).toContain('Cancelled')
    await render(
      <ToolRow part={bash({ state: { status: 'error', input: { command: 'false' } } })} />,
    )
    expect(text()).toContain('Failed')
  })

  it('shows line counts and how long a settled call ran', async () => {
    await render(
      <ToolRow
        part={{
          type: 'tool',
          id: 'edit-1',
          tool: 'Edit',
          toolName: 'Edit',
          kind: 'edit',
          state: { status: 'completed', input: { file_path: 'src/a.ts' } },
          lineChanges: { added: 12, removed: 3 },
          time: { start: 0, end: 4_200 },
        }}
      />,
    )
    expect(text()).toContain('a.ts')
    expect(text()).toContain('+12')
    expect(text()).toContain('-3')
    expect(text()).toContain('4.2s')
    // Nothing to open: a read or an edit carries no text.
    expect(buttons()).toHaveLength(0)
  })

  it('reads a settled call output from the environment only when opened', async () => {
    const fetchToolOutput = vi.fn(async () => 'all 12 tests passed')
    const client = { fetchToolOutput } as unknown as EnvironmentClient
    await render(
      <EnvironmentClientProvider client={client}>
        <ToolRow part={bash({ outputBytes: 19 })} />
      </EnvironmentClientProvider>,
    )
    expect(fetchToolOutput).not.toHaveBeenCalled()
    await act(async () => buttons()[0]!.click())
    expect(fetchToolOutput).toHaveBeenCalledWith(
      { sessionId: 'session-1', toolCallId: 'call-1' },
      expect.objectContaining({ signal: expect.anything() }),
    )
    expect(text()).toContain('all 12 tests passed')
  })

  it('offers a second try when the output could not be read', async () => {
    const fetchToolOutput = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('unavailable'))
      .mockResolvedValueOnce('done')
    const client = { fetchToolOutput } as unknown as EnvironmentClient
    await render(
      <EnvironmentClientProvider client={client}>
        <ToolRow part={bash({ outputBytes: 4 })} />
      </EnvironmentClientProvider>,
    )
    await act(async () => buttons()[0]!.click())
    expect(text()).toContain('The output could not be read.')
    const again = buttons().find((button) => button.textContent === 'Try again')!
    await act(async () => again.click())
    expect(fetchToolOutput).toHaveBeenCalledTimes(2)
    expect(text()).toContain('done')
  })

  it('shows a running call its text so far without a read', async () => {
    const fetchToolOutput = vi.fn(async () => 'never')
    const client = { fetchToolOutput } as unknown as EnvironmentClient
    await render(
      <EnvironmentClientProvider client={client}>
        <ToolRow
          part={bash({
            state: { status: 'running', input: { command: 'pnpm test' }, output: 'RUN v4' },
          })}
        />
      </EnvironmentClientProvider>,
    )
    await act(async () => buttons()[0]!.click())
    expect(text()).toContain('RUN v4')
    expect(fetchToolOutput).not.toHaveBeenCalled()
  })

  it('picks the glyph web picks, by name or from a Cursor title', () => {
    const named = getToolIcon({ toolName: 'Bash', tool: 'Bash' }) as unknown as () => ReactNode
    const titled = getToolIcon({
      tool: '`git status`',
      kind: 'execute',
    }) as unknown as () => ReactNode
    expect(titled).toBe(named)
    const mcp = getToolIcon({ toolName: 'mcp__github__search' }, 'mcp')
    expect(mcp).not.toBe(named)
    expect(getToolIcon({ toolName: 'Delete' })).not.toBe(getToolIcon({ toolName: 'nothing-known' }))
  })
})

describe('notice and failure rows', () => {
  const turnId = 'turn-1'

  it('says a live retry in web words', async () => {
    const live = noticePart(
      {
        noticeId: 'n-1',
        turnId,
        kind: 'retrying',
        message: 'Retrying',
        retry: { attempt: 2, maxAttempts: 5, cause: 'overloaded' },
      },
      true,
    )
    await render(<TurnNoticeRow notice={live.notice} live />)
    expect(text()).toContain('Retrying · attempt 2 of 5 · provider overloaded')
  })

  it('opens a notice that has more to say', async () => {
    await render(
      <TurnNoticeRow
        notice={{
          noticeId: 'n-2',
          turnId,
          kind: 'refusal',
          message: 'Declined',
          detail: 'This request touches a policy.',
        }}
      />,
    )
    expect(text()).toContain('The model declined this request')
    expect(text()).not.toContain('policy')
    await act(async () => buttons()[0]!.click())
    expect(text()).toContain('This request touches a policy.')
  })

  it('retries the newest failed turn when the phone can', async () => {
    const retry = vi.fn(async () => undefined)
    const recovery: TurnRecoveryValue = { retry, busy: false }
    const part = failurePart(
      turnId,
      { reason: 'overloaded', message: 'The provider is overloaded right now.', action: 'retry' },
      true,
    )
    await render(
      <TurnRecoveryContext.Provider value={recovery}>
        <TurnFailureRow part={part} />
      </TurnRecoveryContext.Provider>,
    )
    expect(text()).toContain('The provider is overloaded right now.')
    expect(text()).toContain('This usually passes in a moment.')
    const button = buttons().find((item) => item.textContent === 'Retry')!
    await act(async () => button.click())
    expect(retry).toHaveBeenCalledWith(turnId)
  })

  it('keeps an older failure, or one with no prompt to send, to its guidance', async () => {
    const recovery: TurnRecoveryValue = { retry: async () => undefined, busy: false }
    const failure = {
      reason: 'rate_limited' as const,
      message: 'The provider is rate limiting requests.',
      action: 'retry' as const,
    }
    await render(
      <TurnRecoveryContext.Provider value={recovery}>
        <TurnFailureRow part={failurePart(turnId, failure, false)} />
      </TurnRecoveryContext.Provider>,
    )
    expect(buttons()).toHaveLength(0)
    await render(
      <TurnRecoveryContext.Provider value={recovery}>
        <TurnFailureRow part={failurePart(turnId, failure, true, false)} />
      </TurnRecoveryContext.Provider>,
    )
    expect(buttons()).toHaveLength(0)
    expect(text()).toContain('Send your message again to retry.')
  })

  it('shows guidance alone with no recovery host (the fixture)', async () => {
    await render(
      <TurnFailureRow
        part={failurePart(
          turnId,
          {
            reason: 'overloaded',
            message: 'The provider is overloaded right now.',
            action: 'retry',
          },
          true,
        )}
      />,
    )
    expect(buttons()).toHaveLength(0)
    expect(text()).toContain('This usually passes in a moment.')
  })
})

describe('a failed turn from the projection', () => {
  it('ends on its failure, with its notice and calls that did not complete before it', () => {
    const projection = projectThread(failedThread(Date.parse('2026-10-22T10:00:00.000Z')))
    const reply = projection.messages.find((message) => message.role === 'assistant')!
    const parts = projection.byId.get(reply.externalId)!.content.parts ?? []
    expect(parts.map((part) => part.type)).toEqual(['tool', 'tool', 'tool', 'notice', 'failure'])
    const fold = foldSettledTurn(parts)
    // The usage warning and the failure close the turn rather than being its work.
    expect(fold.answer.map((part) => part.type)).toEqual(['notice', 'failure'])
    expect(parts.at(-1)).toMatchObject({ actionable: true })
  })
})
