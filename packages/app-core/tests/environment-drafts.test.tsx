// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  createMockEnvironmentClient,
  selectDraftContent,
  selectNewSessionDraftId,
  type MockEnvironmentClient,
  type MockSeed,
} from '@openmanager/environment-client'
import { EnvironmentClientProvider } from '../src/providers/environment-client'
import {
  EnvironmentComposerDraftProvider,
  sendingNewSessionDraft,
} from '../src/providers/environment-drafts'
import {
  useComposerDraftStore,
  type ComposerDraftStore,
} from '../src/components/chat/composerDraftStore'
import { COMPOSER_DRAFTS_STORAGE_KEY } from '../src/components/chat/composerDrafts'

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
const SEED: MockSeed = {
  workspaces: [WORKSPACE],
  sessions: [
    {
      session: SESSION,
      providerId: 'opencode',
      threads: [{ threadId: 't1', sessionId: SESSION.sessionId }],
    },
  ],
}

function memoryStorage(): Storage {
  const data = new Map<string, string>()
  return {
    get length() {
      return data.size
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => void data.delete(key),
    setItem: (key, value) => void data.set(key, String(value)),
  }
}

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('localStorage', memoryStorage())
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const settle = async (client: MockEnvironmentClient) => {
  for (let round = 0; round < 6; round += 1) {
    await act(() => client.settle())
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
  }
}

let store: ComposerDraftStore
function Capture() {
  store = useComposerDraftStore()
  return null
}

async function mount(client: MockEnvironmentClient) {
  await act(() =>
    root.render(
      <EnvironmentClientProvider client={client}>
        <EnvironmentComposerDraftProvider>
          <Capture />
        </EnvironmentComposerDraftProvider>
      </EnvironmentClientProvider>,
    ),
  )
  await settle(client)
}

describe('composer drafts over the environment', () => {
  it("keeps a session's text in the environment", async () => {
    const client = createMockEnvironmentClient({ seed: SEED })
    await mount(client)
    act(() => store.setText('session:session-1', 'half a thought'))
    // On screen at once, before any save.
    expect(store.getText('session:session-1')).toBe('half a thought')
    act(() => store.flush())
    await settle(client)
    expect(client.getState().drafts['session-1']).toMatchObject({
      target: { type: 'session', sessionId: 'session-1' },
      content: { text: 'half a thought' },
    })
    expect(client.getState().draftEdits).toEqual({})

    // A composer mounted later reads the same draft.
    await act(() => root.unmount())
    root = createRoot(container)
    await mount(client)
    expect(store.getText('session:session-1')).toBe('half a thought')
  })

  it("writes a project's new-session text to one draft", async () => {
    const client = createMockEnvironmentClient({ seed: SEED })
    await mount(client)
    const key = `draft:${WORKSPACE.workspaceId}`
    act(() => store.setText(key, 'h'))
    act(() => store.setText(key, 'hello'))
    act(() => store.flush())
    await settle(client)
    const drafts = Object.values(client.getState().drafts)
    expect(drafts).toHaveLength(1)
    expect(drafts[0]).toMatchObject({
      target: { type: 'new_session', workspaceId: WORKSPACE.workspaceId },
      content: { text: 'hello' },
    })
    expect(store.getText(key)).toBe('hello')
  })

  it('sets the sent draft aside when send is pressed, so text typed meanwhile is the next one', async () => {
    const client = createMockEnvironmentClient({ seed: SEED })
    await mount(client)
    const key = `draft:${WORKSPACE.workspaceId}`
    act(() => store.setText(key, 'with a screenshot'))
    const sent = selectNewSessionDraftId(client.getState(), WORKSPACE.workspaceId)!

    // The composer clears, then the images upload while the user types on.
    act(() => store.setText(key, ''))
    let release: (() => void) | undefined
    act(() => {
      release = store.beginSend!(key)
    })
    expect(sendingNewSessionDraft(client.drafts!, WORKSPACE.workspaceId)?.draft?.draftId).toBe(sent)
    act(() => store.setText(key, 'and another thing'))
    const next = selectNewSessionDraftId(client.getState(), WORKSPACE.workspaceId)!
    expect(next).not.toBe(sent)
    expect(selectDraftContent(client.getState(), next)?.text).toBe('and another thing')

    // The upload failed: the draft is offered again, and the next one keeps its text.
    act(() => release!())
    expect(sendingNewSessionDraft(client.drafts!, WORKSPACE.workspaceId)).toBeUndefined()
    expect(client.getState().draftEdits[sent]?.launching).toBeUndefined()
    expect(store.getText(key)).toBe('and another thing')
  })

  it('holds an images-only send to no draft, so one arriving meanwhile is not taken', async () => {
    const client = createMockEnvironmentClient({ seed: SEED })
    await mount(client)
    const key = `draft:${WORKSPACE.workspaceId}`
    let release: (() => void) | undefined
    act(() => {
      release = store.beginSend!(key)
    })
    expect(sendingNewSessionDraft(client.drafts!, WORKSPACE.workspaceId)).toEqual({ draft: null })
    act(() => release!())
    expect(sendingNewSessionDraft(client.drafts!, WORKSPACE.workspaceId)).toBeUndefined()
  })

  it('holds text for a key with no project on this page only', async () => {
    const client = createMockEnvironmentClient({ seed: SEED })
    await mount(client)
    act(() => store.setText('landing', 'no project yet'))
    expect(store.getText('landing')).toBe('no project yet')
    act(() => store.flush())
    await settle(client)
    expect(client.getState().drafts).toEqual({})
    expect(client.getState().draftEdits).toEqual({})
  })

  it("imports this browser's old drafts once their session or project is known", async () => {
    localStorage.setItem(
      COMPOSER_DRAFTS_STORAGE_KEY,
      JSON.stringify({
        'session:session-1': { text: 'old session text', updatedAt: 1 },
        [`draft:${WORKSPACE.workspaceId}`]: { text: 'old landing text', updatedAt: 2 },
        // Another environment's session: left for that environment.
        'session:elsewhere': { text: 'not ours', updatedAt: 3 },
      }),
    )
    const client = createMockEnvironmentClient({ seed: SEED })
    await mount(client)
    act(() => store.flush())
    await settle(client)

    const state = client.getState()
    expect(selectDraftContent(state, 'session-1')?.text).toBe('old session text')
    const draftId = selectNewSessionDraftId(state, WORKSPACE.workspaceId)
    expect(draftId && selectDraftContent(state, draftId)?.text).toBe('old landing text')
    expect(JSON.parse(localStorage.getItem(COMPOSER_DRAFTS_STORAGE_KEY)!)).toEqual({
      'session:elsewhere': { text: 'not ours', updatedAt: 3 },
    })
  })
})
