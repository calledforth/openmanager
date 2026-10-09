// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  createMockEnvironmentClient,
  createThreadState,
  type MockEnvironmentClient,
  type MockSeed,
} from '@openmanager/environment-client'
import { MockEnvironmentApp } from '../src/testing/mock-environment-app'
import { MessageParts } from '../src/components/parts/MessageParts'
import { projectThread } from '../src/lib/environment-thread'
import {
  describeFailure,
  describeNotice,
  failurePart,
  formatResetTime,
} from '../src/lib/turn-notice-parts'
import { TurnRecoveryContext, type TurnRecoveryValue } from '../src/providers/turn-recovery'

const WORKSPACE = {
  workspaceId: 'C:/repo',
  name: 'repo',
  path: 'C:/repo',
  lastUsedAt: null,
  lastActivityAt: null,
  capabilities: { git: false, providers: ['opencode'] },
  exists: true,
}
const SESSION = { sessionId: 'session-1', workspaceId: WORKSPACE.workspaceId, title: 'First' }
const THREAD = { threadId: 'thread-1', sessionId: SESSION.sessionId }
const SEED: MockSeed = {
  workspaces: [WORKSPACE],
  sessions: [{ session: SESSION, threads: [THREAD], turns: [], messages: [] }],
  activeSessionId: SESSION.sessionId,
}

const notice = (patch: Record<string, unknown>) => ({
  noticeId: 'n1',
  turnId: 't1',
  message: 'A notice',
  ...patch,
})

describe('notice and failure wording', () => {
  it('says where a retry is up to and why', () => {
    expect(
      describeNotice(
        notice({
          kind: 'retrying',
          retry: { attempt: 2, maxAttempts: 10, cause: 'overloaded' },
        }) as never,
      ),
    ).toEqual({ label: 'Retrying', detail: 'attempt 2 of 10 · provider overloaded', tone: 'muted' })
    expect(describeNotice(notice({ kind: 'retrying' }) as never).label).toBe(
      'Recovering from a temporary error',
    )
  })

  it('marks a compaction with what it saved', () => {
    expect(
      describeNotice(
        notice({
          kind: 'compacted',
          compaction: { trigger: 'auto', tokensBefore: 180_000, tokensAfter: 4_200 },
        }) as never,
      ),
    ).toEqual({
      label: 'Conversation compacted',
      detail: 'automatically · 180k → 4.2k tokens',
      tone: 'muted',
    })
  })

  it('names the models of a fallback and keeps the explanation to disclose', () => {
    expect(
      describeNotice(
        notice({
          kind: 'model_fallback',
          model: { from: 'opus', to: 'sonnet' },
          detail: 'Policy text',
        }) as never,
      ),
    ).toEqual({
      label: 'Switched to sonnet',
      detail: 'opus declined',
      body: 'Policy text',
      tone: 'muted',
    })
  })

  it('formats a reset time today as a time, and later as a day', () => {
    const now = new Date('2026-10-09T10:00:00')
    expect(formatResetTime('2026-10-09T15:00:00', now)).toMatch(/3:00/)
    expect(formatResetTime('2026-10-11T15:00:00', now)).toMatch(/^\S+ .*3:00/)
    expect(formatResetTime('not a time', now)).toBeUndefined()
  })

  it.each([
    [{ reason: 'overloaded', action: 'retry' }, 'This usually passes in a moment.', 'Retry'],
    [
      { reason: 'context_window_exceeded', action: 'compact' },
      'Compact the conversation to continue, or start a new chat.',
      'Compact',
    ],
    [
      { reason: 'authentication_required', action: 'sign_in' },
      'Sign in to Claude on the machine running this environment, then retry.',
      'Retry',
    ],
    [{ reason: 'usage_limit' }, "Check your plan's usage, or switch provider.", undefined],
    [{ reason: 'refused' }, 'Try rephrasing the request.', undefined],
  ] as const)('guides %j and offers %s', (failure, guidance, label) => {
    const copy = describeFailure({ message: 'Failed', ...failure }, 'Claude')
    expect(copy.guidance).toBe(guidance)
    expect(copy.action?.label).toBe(label)
  })

  it('says when a usage limit resets', () => {
    const now = new Date('2026-10-09T10:00:00')
    expect(
      describeFailure(
        { reason: 'usage_limit', message: 'Limit', resetsAt: '2026-10-09T15:00:00' },
        undefined,
        now,
      ).guidance,
    ).toMatch(/^Resets .*3:00/)
  })
})

describe('projecting notices and failures', () => {
  const base = { ...createThreadState(THREAD, 'ready') }
  const userMessage = (turnId: string) => ({
    messageId: `${turnId}-user`,
    threadId: THREAD.threadId,
    turnId,
    role: 'user' as const,
    content: [{ type: 'text' as const, text: 'Do it' }],
  })

  it('places a durable notice where it happened among the turn parts', () => {
    const state = {
      ...base,
      turns: [{ turnId: 't1', threadId: THREAD.threadId, state: 'completed' as const }],
      messages: [
        userMessage('t1'),
        {
          messageId: 'a1',
          threadId: THREAD.threadId,
          turnId: 't1',
          role: 'assistant' as const,
          content: [{ type: 'text' as const, text: 'Before' }],
        },
        {
          messageId: 'a2',
          threadId: THREAD.threadId,
          turnId: 't1',
          role: 'assistant' as const,
          content: [{ type: 'text' as const, text: 'After' }],
        },
      ],
      notices: [{ noticeId: 'n1', turnId: 't1', kind: 'compacted' as const, message: 'Compacted' }],
      order: [
        { kind: 'message' as const, id: 't1-user', turnId: 't1' },
        { kind: 'message' as const, id: 'a1', turnId: 't1' },
        { kind: 'notice' as const, id: 'n1', turnId: 't1' },
        { kind: 'message' as const, id: 'a2', turnId: 't1' },
      ],
    }
    const row = projectThread(state).byId.get('a1')!
    expect(row.content.parts?.map((part) => `${part.type}:${part.id}`)).toEqual([
      'text:a1',
      'notice:notice:n1',
      'text:a2',
    ])
  })

  it('shows a live notice at the end of a running turn and drops it once it ends', () => {
    const live = {
      noticeId: 'r1',
      turnId: 't1',
      kind: 'retrying' as const,
      message: 'Retrying',
      retry: { attempt: 1 },
    }
    const running = {
      ...base,
      turns: [{ turnId: 't1', threadId: THREAD.threadId, state: 'running' as const }],
      messages: [userMessage('t1')],
      liveNotices: [live],
    }
    const first = projectThread(running)
    expect(first.byId.get('turn:t1:assistant')!.content.parts).toEqual([
      expect.objectContaining({ type: 'notice', id: 'live-notice:t1', live: true }),
    ])
    const ended = projectThread(
      { ...running, turns: [{ ...running.turns[0]!, state: 'completed' as const }] },
      first,
    )
    expect(ended.byId.get('turn:t1:assistant')).toBeUndefined()
  })

  it('offers Retry only when the prompt it would resend is loaded', () => {
    const failure = { reason: 'overloaded' as const, message: 'Busy', action: 'retry' as const }
    const failed = (messages: ReturnType<typeof userMessage>[]) =>
      projectThread({
        ...base,
        turns: [{ turnId: 't1', threadId: THREAD.threadId, state: 'failed' as const, failure }],
        messages,
      })
        .byId.get('turn:t1:assistant')!
        .content.parts?.at(-1)
    expect(failed([userMessage('t1')])).toMatchObject({ actionable: true, resendable: true })
    // A background turn, or a prompt on a history page not loaded yet.
    expect(failed([])).toMatchObject({ actionable: true, resendable: false })
  })

  it('offers a failure its action only on the newest turn', () => {
    const failure = { reason: 'overloaded' as const, message: 'Busy', action: 'retry' as const }
    const state = {
      ...base,
      turns: [
        { turnId: 't1', threadId: THREAD.threadId, state: 'failed' as const, failure },
        { turnId: 't2', threadId: THREAD.threadId, state: 'failed' as const, failure },
      ],
      messages: [userMessage('t1'), userMessage('t2')],
    }
    const projection = projectThread(state)
    expect(projection.byId.get('turn:t1:assistant')!.content.parts?.at(-1)).toMatchObject({
      type: 'failure',
      actionable: false,
    })
    expect(projection.byId.get('turn:t2:assistant')!.content.parts?.at(-1)).toMatchObject({
      type: 'failure',
      actionable: true,
      failure,
    })
  })
})

describe('rendering notices and failures', () => {
  const recovery = (patch: Partial<TurnRecoveryValue> = {}): TurnRecoveryValue => ({
    retry: vi.fn(async () => undefined),
    compact: vi.fn(async () => undefined),
    providerName: 'Claude',
    busy: false,
    ...patch,
  })
  const markup = (parts: Parameters<typeof MessageParts>[0]['parts'], value = recovery()) =>
    renderToStaticMarkup(
      <TurnRecoveryContext.Provider value={value}>
        <MessageParts parts={parts} />
      </TurnRecoveryContext.Provider>,
    )

  it('renders a notice as one line and a policy explanation behind a disclosure', () => {
    const html = markup([
      {
        type: 'notice',
        id: 'notice:n1',
        notice: { noticeId: 'n1', turnId: 't1', kind: 'warning', message: 'Settings ignored' },
      },
      {
        type: 'notice',
        id: 'notice:n2',
        notice: {
          noticeId: 'n2',
          turnId: 't1',
          kind: 'refusal',
          message: 'Declined',
          detail: 'Explained here',
        },
      },
    ])
    expect(html).toContain('Settings ignored')
    expect(html).toContain('<details')
    expect(html).toContain('Explained here')
  })

  it('renders a failure with its guidance and button, and no button when not actionable', () => {
    const failure = {
      reason: 'authentication_required' as const,
      message: 'Sign in needed',
      action: 'sign_in' as const,
    }
    const html = markup([failurePart('t1', failure, true)])
    expect(html).toContain('Sign in needed')
    expect(html).toContain('Sign in to Claude on the machine running this environment')
    expect(html).toContain('>Retry</button>')
    expect(markup([failurePart('t1', failure, false)])).not.toContain('<button')
    // Nothing loaded to resend: guidance, never a dead button.
    const unsendable = markup([failurePart('t1', failure, true, false)])
    expect(unsendable).not.toContain('<button')
    expect(unsendable).toContain('then send your message again')
    // Compacting needs no prompt.
    expect(
      markup([
        failurePart(
          't1',
          { reason: 'context_window_exceeded', message: 'Long', action: 'compact' },
          true,
          false,
        ),
      ]),
    ).toContain('>Compact</button>')
    // A host with no way to retry shows the guidance alone, never a dead button.
    expect(
      markup([failurePart('t1', failure, true)], recovery({ retry: undefined })),
    ).not.toContain('<button')
  })
})

describe('recovering from a failed turn in the app', () => {
  let container: HTMLDivElement
  let root: Root
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
    }))
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })
  afterEach(async () => {
    await act(() => root.unmount())
    container.remove()
    globalThis.localStorage?.clear()
    vi.unstubAllGlobals()
  })
  const render = (node: ReactNode) => act(() => root.render(node))
  const settle = async (client: MockEnvironmentClient) => {
    for (let round = 0; round < 6; round += 1) {
      await act(() => client.settle())
      await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
    }
  }
  const buttonWithText = (text: string) =>
    [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (node) => node.textContent === text,
    )
  const start = async (text: string) => {
    const client = createMockEnvironmentClient({ seed: SEED, respond: () => null })
    await render(<MockEnvironmentApp client={client} />)
    const { turn } = await act(() => client.commands.sendTurn({ ...THREAD, text }))
    await settle(client)
    return { client, target: { ...THREAD, turnId: turn.turnId } }
  }

  it('shows a retry while it happens and drops it once the reply streams', async () => {
    const { client, target } = await start('long task')
    await act(() =>
      client.notice(target, {
        kind: 'retrying',
        message: 'Retrying',
        retry: { attempt: 2, maxAttempts: 10, cause: 'overloaded' },
      }),
    )
    expect(container.textContent).toContain('attempt 2 of 10')
    await act(() => {
      client.streamAssistantText(target, 'Back on track', 'assistant-1')
    })
    expect(container.textContent).toContain('Back on track')
    expect(container.textContent).not.toContain('attempt 2 of 10')
  })

  it('retries the failed prompt as a new turn', async () => {
    const { client, target } = await start('build the thing')
    await act(() =>
      client.failTurn(target, 'overloaded', 'The provider is overloaded right now.', {
        action: 'retry',
      }),
    )
    expect(container.textContent).toContain('The provider is overloaded right now.')
    // A second click before the first has re-rendered must not send twice.
    await act(async () => {
      buttonWithText('Retry')!.click()
      buttonWithText('Retry')!.click()
    })
    await settle(client)
    const sends = client.calls.filter((call) => call.command === 'sendTurn')
    expect(sends).toHaveLength(2)
    expect(sends.at(-1)?.input).toMatchObject({ ...THREAD, text: 'build the thing' })
  })

  it('offers no Retry for a turn with no prompt to send, and says what to do', async () => {
    const client = createMockEnvironmentClient({ seed: SEED, respond: () => null })
    await render(<MockEnvironmentApp client={client} />)
    await settle(client)
    // A turn the provider began by itself: nobody sent a prompt.
    await act(() =>
      client.emit({
        type: 'event',
        name: 'turn.started',
        eventId: 'background-start',
        timestamp: '2026-10-09T10:00:00.000Z',
        scope: {
          type: 'thread',
          environmentId: client.getState().environment!.environmentId,
          ...THREAD,
        },
        payload: {
          turn: {
            turnId: 'background-1',
            threadId: THREAD.threadId,
            state: 'running',
            origin: 'background',
          },
        },
      }),
    )
    await act(() =>
      client.failTurn({ ...THREAD, turnId: 'background-1' }, 'overloaded', 'Overloaded.', {
        action: 'retry',
      }),
    )
    expect(container.textContent).toContain('Overloaded.')
    expect(container.textContent).toContain('Send your message again to retry.')
    expect(buttonWithText('Retry')).toBeUndefined()
  })

  it('holds recovery while a message from the composer is still being sent', async () => {
    const client = createMockEnvironmentClient({
      seed: {
        ...SEED,
        sessions: [
          {
            session: SESSION,
            threads: [THREAD],
            turns: [
              {
                turnId: 'failed-1',
                threadId: THREAD.threadId,
                state: 'failed',
                failure: { reason: 'overloaded', message: 'Overloaded.', action: 'retry' },
              },
            ],
            messages: [
              {
                messageId: 'failed-1-user',
                threadId: THREAD.threadId,
                turnId: 'failed-1',
                role: 'user',
                content: [{ type: 'text', text: 'first try' }],
              },
            ],
          },
        ],
      },
      respond: () => null,
      latencyMs: 50,
    })
    await render(<MockEnvironmentApp client={client} />)
    await settle(client)
    expect(buttonWithText('Retry')?.disabled).toBe(false)

    const textarea = container.querySelector('textarea')!
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    await act(() => {
      setter.call(textarea, 'something else')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(() =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!.click(),
    )
    // The send has not reached the environment yet: Retry must wait for it.
    expect(buttonWithText('Retry')?.disabled).toBe(true)
    await act(() => buttonWithText('Retry')!.click())
    await settle(client)
    const texts = client.calls
      .filter((call) => call.command === 'sendTurn')
      .map((call) => (call.input as { text: string }).text)
    expect(texts).toEqual(['something else'])
  })

  it('compacts the conversation when it no longer fits', async () => {
    const { client, target } = await start('keep going')
    await act(() =>
      client.failTurn(target, 'context_window_exceeded', 'Too long.', { action: 'compact' }),
    )
    await act(() => buttonWithText('Compact')!.click())
    await settle(client)
    expect(client.calls.filter((call) => call.command === 'sendTurn').at(-1)?.input).toMatchObject({
      text: '/compact',
    })
  })
})
