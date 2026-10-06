// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  createMockEnvironmentClient,
  selectDraftContent,
  selectNewSessionDraftIds,
  type MockEnvironmentClient,
  type MockSeed,
} from '@openmanager/environment-client'
import { EnvironmentClientProvider } from '../src/providers/environment-client'
import {
  EnvironmentComposerDraftProvider,
  newSessionDraftKey,
  sendingNewSessionDraft,
} from '../src/providers/environment-drafts'
import {
  DraftPageContext,
  DraftPicksContext,
  type DraftPageInternals,
  type DraftPagePicks,
} from '../src/providers/draft-pages'
import {
  useComposerDraftStore,
  type ComposerDraftStore,
} from '../src/components/chat/composerDraftStore'
import { COMPOSER_DRAFTS_STORAGE_KEY } from '../src/components/chat/composerDrafts'
import { DraftSyncIndicator } from '../src/components/chat/DraftSyncIndicator'

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

/** The page the composer sits on: one blank draft, its ids minted up front. */
const PAGE_DRAFT = 'page-draft'
const PAGE_SESSION = 'page-session'
const PAGE_KEY = newSessionDraftKey(PAGE_DRAFT)

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
let claimed: string[] = []
let pagePicks: Record<string, ReturnType<DraftPagePicks>> = {}
const page: DraftPageInternals = {
  pageDraftId: PAGE_DRAFT,
  pageTarget: (draftId) =>
    draftId === PAGE_DRAFT
      ? { type: 'new_session', workspaceId: WORKSPACE.workspaceId, sessionId: PAGE_SESSION }
      : undefined,
  claim: (draftId) => void claimed.push(draftId),
}
const picksOf: DraftPagePicks = (draftId) => pagePicks[draftId]

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('localStorage', memoryStorage())
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  indicatorKey = null
  claimed = []
  pagePicks = {}
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
let indicatorKey: string | null = null
function Capture() {
  store = useComposerDraftStore()
  return indicatorKey ? <DraftSyncIndicator store={store} draftKey={indicatorKey} /> : null
}

async function mount(client: MockEnvironmentClient) {
  await act(() =>
    root.render(
      <EnvironmentClientProvider client={client}>
        <DraftPageContext.Provider value={page}>
          <DraftPicksContext.Provider value={picksOf}>
            <EnvironmentComposerDraftProvider>
              <Capture />
            </EnvironmentComposerDraftProvider>
          </DraftPicksContext.Provider>
        </DraftPageContext.Provider>
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

  it('saves nothing for a blank page until its first text, which also gives it its address', async () => {
    const client = createMockEnvironmentClient({ seed: SEED })
    await mount(client)
    // Picks made on the page so far ride along with the first save.
    pagePicks[PAGE_DRAFT] = { providerId: 'opencode', preference: { modelId: 'opus' } }
    act(() => store.setText(PAGE_KEY, ''))
    expect(client.getState().draftEdits).toEqual({})
    expect(claimed).toEqual([])

    act(() => store.setText(PAGE_KEY, 'h'))
    act(() => store.setText(PAGE_KEY, 'hello'))
    expect(claimed[0]).toBe(PAGE_DRAFT)
    act(() => store.flush())
    await settle(client)
    expect(Object.values(client.getState().drafts)).toEqual([
      expect.objectContaining({
        draftId: PAGE_DRAFT,
        target: {
          type: 'new_session',
          workspaceId: WORKSPACE.workspaceId,
          sessionId: PAGE_SESSION,
        },
        content: { text: 'hello', providerId: 'opencode', preference: { modelId: 'opus' } },
      }),
    ])
    expect(store.getText(PAGE_KEY)).toBe('hello')
    expect(selectNewSessionDraftIds(client.getState())).toEqual([PAGE_DRAFT])
  })

  it('gives a draft its address when an image is attached, without saving it', async () => {
    const client = createMockEnvironmentClient({ seed: SEED })
    await mount(client)
    act(() => store.claim!(PAGE_KEY))
    expect(claimed).toEqual([PAGE_DRAFT])
    expect(client.getState().draftEdits).toEqual({})
  })

  it('sets the sent draft aside when send is pressed, so text typed meanwhile is the next one', async () => {
    const client = createMockEnvironmentClient({ seed: SEED })
    await mount(client)
    act(() => store.setText(PAGE_KEY, 'with a screenshot'))

    // The composer clears, then the images upload while the user types on.
    act(() => store.setText(PAGE_KEY, ''))
    let release: (() => void) | undefined
    act(() => {
      release = store.beginSend!(PAGE_KEY)
    })
    expect(sendingNewSessionDraft(client.drafts!, PAGE_DRAFT)).toEqual({
      draftId: PAGE_DRAFT,
      sessionId: PAGE_SESSION,
      workspaceId: WORKSPACE.workspaceId,
    })
    act(() => store.setText(PAGE_KEY, 'and another thing'))
    expect(store.getText(PAGE_KEY)).toBe('and another thing')
    const [next] = selectNewSessionDraftIds(client.getState())
    expect(next).not.toBe(PAGE_DRAFT)
    expect(selectDraftContent(client.getState(), next!)).toEqual({ text: 'and another thing' })
    // The send's draft keeps what it was sent with.
    expect(selectDraftContent(client.getState(), PAGE_DRAFT)?.text).toBe('')

    // The upload failed: the draft is the page's again, and what was typed
    // meanwhile is kept as a draft of its own.
    act(() => release!())
    expect(sendingNewSessionDraft(client.drafts!, PAGE_DRAFT)).toBeUndefined()
    expect(client.getState().draftEdits[PAGE_DRAFT]?.launching).toBeUndefined()
    expect(selectDraftContent(client.getState(), next!)?.text).toBe('and another thing')
  })

  it('holds an images-only send to the page draft and the session minted with it', async () => {
    const client = createMockEnvironmentClient({ seed: SEED })
    await mount(client)
    let release: (() => void) | undefined
    act(() => {
      release = store.beginSend!(PAGE_KEY)
    })
    expect(sendingNewSessionDraft(client.drafts!, PAGE_DRAFT)?.sessionId).toBe(PAGE_SESSION)
    act(() => release!())
    expect(sendingNewSessionDraft(client.drafts!, PAGE_DRAFT)).toBeUndefined()
  })

  it("keeps a draft's images in the draft itself, so its first image saves it", async () => {
    const client = createMockEnvironmentClient({ seed: SEED })
    await mount(client)
    pagePicks[PAGE_DRAFT] = { providerId: 'opencode' }
    expect(store.keepsImages!(PAGE_KEY)).toBe(true)
    expect(store.keepsImages!('session:session-1')).toBe(true)
    // Held on this page only: nowhere to keep an image.
    expect(store.keepsImages!('landing')).toBe(false)
    expect(store.getImages!(PAGE_KEY)).toEqual([])

    act(() => store.setImages!(PAGE_KEY, ['artifact-1']))
    expect(claimed).toEqual([PAGE_DRAFT])
    const images = store.getImages!(PAGE_KEY)
    expect(images).toEqual(['artifact-1'])
    // The same array until it changes, as a store snapshot must be.
    expect(store.getImages!(PAGE_KEY)).toBe(images)
    act(() => store.setText(PAGE_KEY, 'what is this?'))
    act(() => store.flush())
    await settle(client)
    expect(client.getState().drafts[PAGE_DRAFT]?.content).toEqual({
      text: 'what is this?',
      providerId: 'opencode',
      artifactIds: ['artifact-1'],
    })
    // Read back through the draft that names it: it has no session yet.
    expect(store.imageSource!(PAGE_KEY, 'artifact-1')).toEqual({
      draftId: PAGE_DRAFT,
      artifactId: 'artifact-1',
    })
    expect(store.imageSource!('session:session-1', 'artifact-2')).toEqual({
      sessionId: 'session-1',
      artifactId: 'artifact-2',
    })

    // Taking the last one out leaves no empty list behind.
    act(() => store.setImages!(PAGE_KEY, []))
    expect(selectDraftContent(client.getState(), PAGE_DRAFT)).toEqual({
      text: 'what is this?',
      providerId: 'opencode',
    })
  })

  it("keeps a session's images in its draft", async () => {
    const client = createMockEnvironmentClient({ seed: SEED })
    await mount(client)
    act(() => store.setImages!('session:session-1', ['artifact-1', 'artifact-2']))
    act(() => store.flush())
    await settle(client)
    expect(client.getState().drafts['session-1']?.content).toEqual({
      text: '',
      artifactIds: ['artifact-1', 'artifact-2'],
    })
    expect(store.getImages!('session:session-1')).toEqual(['artifact-1', 'artifact-2'])
  })

  it('shows the images a send took on its draft while it is sent', async () => {
    const client = createMockEnvironmentClient({ seed: SEED })
    await mount(client)
    act(() => store.setText(PAGE_KEY, 'look'))
    act(() => store.setImages!(PAGE_KEY, ['artifact-1']))
    // The composer empties the box, then sets the draft aside with what it held.
    act(() => store.setText(PAGE_KEY, ''))
    act(() => store.setImages!(PAGE_KEY, []))
    act(() => {
      store.beginSend!(PAGE_KEY, 'look', ['artifact-1'])
    })
    expect(client.getState().draftEdits[PAGE_DRAFT]).toMatchObject({
      launching: true,
      sent: { text: 'look', artifactIds: ['artifact-1'] },
    })
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
    // A project's old landing text is a draft of its own, not the page's.
    const [draftId] = selectNewSessionDraftIds(state)
    expect(draftId).not.toBe(PAGE_DRAFT)
    expect(selectDraftContent(state, draftId!)).toEqual({ text: 'old landing text' })
    expect(JSON.parse(localStorage.getItem(COMPOSER_DRAFTS_STORAGE_KEY)!)).toEqual({
      'session:elsewhere': { text: 'not ours', updatedAt: 3 },
    })
  })

  it('shows drafts edited or started offline as not synced until the environment has them', async () => {
    const client = createMockEnvironmentClient({ seed: SEED })
    const sessionKey = 'session:session-1'
    indicatorKey = sessionKey
    await mount(client)
    act(() => client.disconnect())
    act(() => store.setText(sessionKey, 'typed offline'))
    act(() => store.setText(PAGE_KEY, 'a new chat, offline'))
    expect(store.getSyncStatus?.(sessionKey)).toBe('offline')
    expect(store.getSyncStatus?.(PAGE_KEY)).toBe('offline')
    expect(container.textContent).toContain('Not synced')
    act(() => store.flush())
    await settle(client)
    // Nothing reached the environment, and nothing was dropped.
    expect(client.getState().drafts).toEqual({})
    expect(store.getText(sessionKey)).toBe('typed offline')
    expect(store.getText(PAGE_KEY)).toBe('a new chat, offline')

    act(() => client.connect())
    await settle(client)
    expect(store.getSyncStatus?.(sessionKey)).toBe('synced')
    expect(store.getSyncStatus?.(PAGE_KEY)).toBe('synced')
    expect(container.textContent).not.toContain('Not synced')
    const texts = Object.values(client.getState().drafts).map((draft) => draft.content.text)
    expect(texts.sort()).toEqual(['a new chat, offline', 'typed offline'])
  })
})
