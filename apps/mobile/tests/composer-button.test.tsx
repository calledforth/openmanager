// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  EnvironmentApplicationProviders,
  EnvironmentClientProvider,
} from '@openmanager/app-core/logic'
import {
  createMockEnvironmentClient,
  type MockSeed,
  type ProviderCatalogEntry,
} from '@openmanager/environment-client'

import type { PhoneConnectionState } from '../src/environment/controller'
import type { ComposerModel } from '../src/composer/model'

// The button as the dock draws it, on react-native-web: its own Press, its
// own glyphs and its own wiring to the composer's send and stop.
// @ts-expect-error -- react-native-web ships no types; it stands in for react-native here.
vi.mock('react-native', async () => await import('react-native-web'))
vi.mock('react-native-svg', () => {
  const Stub = ({ children }: { children?: unknown }) => children ?? null
  return { default: Stub, Path: Stub, Rect: Stub }
})
vi.mock('../src/ui/haptics', () => ({ tap: () => undefined }))
// Any colour will do here (the token map pulls in NativeWind's native runtime).
vi.mock('../src/theme/ThemeProvider', () => {
  const ink: Record<string, unknown> = new Proxy({}, { get: () => '#888888' })
  const theme = new Proxy({}, { get: (_target, key) => (key === 'status' ? ink : '#888888') })
  return { usePhoneTheme: () => theme }
})
const connection = { status: 'connected' } as unknown as PhoneConnectionState
vi.mock('../src/environment/PhoneEnvironmentProvider', () => ({
  usePhoneConnection: () => connection,
}))

const { useLiveComposerModel } = await import('../src/composer/useLiveComposerModel')
const { ThreadBridge } = await import('../src/composer/thread-port')
const { PrimaryButton } = await import('../src/composer/Pick')

const WORKSPACE = {
  workspaceId: 'C:/repo',
  name: 'repo',
  path: 'C:/repo',
  lastUsedAt: null,
  lastActivityAt: null,
  capabilities: { git: false, providers: ['claude'] },
  exists: true,
}
const SESSION = { sessionId: 'session-1', workspaceId: WORKSPACE.workspaceId, title: 'First' }
const THREAD = { threadId: 'thread-1', sessionId: SESSION.sessionId }
const CLAUDE = {
  id: 'claude',
  displayName: 'Claude Code',
  capabilities: {
    canSetModel: true,
    canSetMode: true,
    canSetConfigOption: true,
    canDeleteSession: false,
    canLoadSession: true,
    canListSessions: true,
    canCancelPrompt: true,
    supportsPlans: true,
    supportsAvailableCommands: true,
    supportsUsage: true,
    supportsPermissionRequests: true,
    supportsAuthentication: false,
    supportsThoughtStreaming: false,
    supportsSubtasks: false,
    supportsExtensions: false,
    supportsQuestions: true,
  },
  health: {
    summary: 'ready',
    refreshing: false,
    install: 'installed',
    auth: 'authenticated',
    runtime: { state: 'running', liveProcesses: 1, activeTurns: 0 },
    lastProbe: null,
    update: 'current',
  },
  profile: {
    providerId: 'claude',
    availableModels: [{ modelId: 'opus', name: 'Opus' }],
    availableModes: [
      { id: 'default', name: 'Default' },
      { id: 'plan', name: 'Plan' },
    ],
    updatedAt: 1_700_000_000_000,
  },
} as unknown as ProviderCatalogEntry
const SEED: MockSeed = {
  workspaces: [WORKSPACE],
  providers: [CLAUDE],
  sessions: [
    {
      session: SESSION,
      providerId: 'claude',
      status: 'running',
      threads: [THREAD],
      turns: [{ turnId: 'turn-1', threadId: THREAD.threadId, state: 'running' }],
      messages: [],
    },
  ],
}

let model: ComposerModel | null = null
function Dock() {
  const live = useLiveComposerModel(SESSION.sessionId)
  model = live.model
  return (
    <>
      <ThreadBridge port={live.port} />
      {/* Wired as ComposerDock wires it. */}
      <PrimaryButton
        action={live.model.primary}
        onSend={live.model.send}
        onStop={live.model.interrupt}
      />
    </>
  )
}

let container: HTMLDivElement
let root: Root
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
const flush = async (rounds = 8) => {
  for (let round = 0; round < rounds; round += 1) {
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
  }
}

describe('the rendered send button during a plan review', () => {
  it('sends the change request, and does not stop the waiting turn', async () => {
    const client = createMockEnvironmentClient({ seed: SEED, respond: () => null })
    await act(() =>
      root.render(
        <EnvironmentClientProvider client={client}>
          <EnvironmentApplicationProviders storage={null} navigateDraft={async () => undefined}>
            <Dock />
          </EnvironmentApplicationProviders>
        </EnvironmentClientProvider>,
      ),
    )
    await act(() => client.commands.openSession(SESSION.sessionId))
    await flush()
    await act(() =>
      client.requestInteraction(
        { ...THREAD, turnId: 'turn-1' },
        {
          kind: 'plan',
          interactionId: 'plan-1',
          name: 'Grid',
          markdown: '## Steps',
          todos: [],
          continuation: 'same_turn',
        },
      ),
    )
    await flush()
    await act(async () => model!.setText('Use a masonry grid'))
    await flush()
    expect(model!.isStreaming).toBe(true)

    const button = container.querySelector('[aria-label="Send"]') as HTMLElement | null
    expect(button).not.toBeNull()
    expect(container.querySelector('[aria-label="Stop"]')).toBeNull()
    await act(async () => {
      button!.click()
    })
    await flush()
    const commands = client.calls.map((call) => call.command)
    expect(commands).toContain('respondToInteraction')
    expect(commands).not.toContain('interruptTurn')
    expect(
      client.calls.find((call) => call.command === 'respondToInteraction')?.input,
    ).toMatchObject({
      response: {
        kind: 'plan',
        interactionId: 'plan-1',
        outcome: { outcome: 'rejected', reason: 'Use a masonry grid' },
      },
    })
  })
})
