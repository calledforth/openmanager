// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  createMockEnvironmentClient,
  selectDraftContent,
  type MockEnvironmentClient,
  type MockSeed,
} from '@openmanager/environment-client'
import { EnvironmentClientProvider } from '../src/providers/environment-client'
import {
  EnvironmentComposerDraftProvider,
  newSessionDraftKey,
} from '../src/providers/environment-drafts'
import { DraftPageContext, type DraftPageInternals } from '../src/providers/draft-pages'
import { MessageInputView } from '../src/components/chat/MessageInputView'
import type {
  DraftImageAttachment,
  KeptImage,
  UploadedImageAttachment,
} from '../src/lib/attachments'
import { ThemeProvider } from '../src/providers/theme-provider'

const WORKSPACE = {
  workspaceId: 'C:/repo',
  name: 'repo',
  path: 'C:/repo',
  lastUsedAt: null,
  lastActivityAt: null,
  capabilities: { git: false, providers: ['opencode'] },
  exists: true,
}
const SEED: MockSeed = { workspaces: [WORKSPACE] }
const PAGE_DRAFT = 'page-draft'
const PAGE_SESSION = 'page-session'
const PAGE_KEY = newSessionDraftKey(PAGE_DRAFT)

const page: DraftPageInternals = {
  pageDraftId: PAGE_DRAFT,
  pageTarget: (draftId) =>
    draftId === PAGE_DRAFT
      ? { type: 'new_session', workspaceId: WORKSPACE.workspaceId, sessionId: PAGE_SESSION }
      : undefined,
  claim: () => undefined,
}

let container: HTMLDivElement
let root: Root
let urls = 0
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
  urls = 0
  URL.createObjectURL = vi.fn(() => `blob:preview-${(urls += 1)}`)
  URL.revokeObjectURL = vi.fn()
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

type Sent = { text: string; attachments: DraftImageAttachment[]; kept: KeptImage[] }

async function mount(
  client: MockEnvironmentClient,
  options: {
    onSend?: (sent: Sent) => Promise<void>
    uploadImage?: (image: DraftImageAttachment) => Promise<UploadedImageAttachment>
    draftKey?: string
  } = {},
) {
  const sent: Sent[] = []
  const uploads: DraftImageAttachment[] = []
  const uploadImage =
    options.uploadImage ??
    (async (image: DraftImageAttachment) => {
      uploads.push(image)
      const stored = await client.uploadArtifact!({
        workspaceId: WORKSPACE.workspaceId,
        name: image.file.name,
        mimeType: image.file.type,
        bytes: image.file,
      })
      return {
        id: stored.artifactId,
        name: stored.name,
        mimeType: stored.mimeType,
        size: stored.sizeBytes,
        previewUrl: image.previewUrl,
        workspaceId: stored.workspaceId,
      }
    })
  await act(() =>
    root.render(
      <ThemeProvider>
        <EnvironmentClientProvider client={client}>
          <DraftPageContext.Provider value={page}>
            <EnvironmentComposerDraftProvider>
              <MessageInputView
                disabled={false}
                pendingDraftSessionStart={false}
                activeWorkspacePath={WORKSPACE.workspaceId}
                activeSessionId={null}
                isSessionDraftOpen
                providerReady
                currentProviderId="opencode"
                providerModelGroups={[]}
                currentModelId=""
                configOptions={[]}
                modeOptions={[]}
                effortLevels={[]}
                currentEffort=""
                currentModeId=""
                canChangeSettings={false}
                canChangeProvider={false}
                showModeControl={false}
                showModelControl={false}
                isStreaming={false}
                draftKey={options.draftKey ?? PAGE_KEY}
                imageUploadEnabled
                imageSupportMessage={null}
                onModeChange={() => undefined}
                onProviderModelChange={() => undefined}
                onConfigOptionChange={() => undefined}
                onSend={async (text, attachments, kept = []) => {
                  sent.push({ text, attachments, kept })
                  await options.onSend?.({ text, attachments, kept })
                }}
                onAbort={() => undefined}
                uploadImage={uploadImage}
              />
            </EnvironmentComposerDraftProvider>
          </DraftPageContext.Provider>
        </EnvironmentClientProvider>
      </ThemeProvider>,
    ),
  )
  await settle(client)
  return { sent, uploads }
}

const textarea = () => container.querySelector('textarea')!

async function attach(...names: string[]) {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')!
  const files = names.map((name) => new File(['png'], name, { type: 'image/png' }))
  Object.defineProperty(input, 'files', { value: files, configurable: true })
  await act(() => {
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

async function type(text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  await act(() => {
    setter.call(textarea(), text)
    textarea().dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function pressEnter() {
  await act(async () => {
    textarea().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
}

const thumbnails = () =>
  [...container.querySelectorAll<HTMLImageElement>('img')].map((img) => img.getAttribute('alt'))

describe('images kept with the composer draft', () => {
  it('uploads an image when it is attached and names it in the draft', async () => {
    const client = createMockEnvironmentClient({ seed: SEED })
    const { uploads } = await mount(client)

    await attach('screenshot.png')
    expect(uploads.map((upload) => upload.file.name)).toEqual(['screenshot.png'])
    await settle(client)

    const [artifactId] = selectDraftContent(client.getState(), PAGE_DRAFT)?.artifactIds ?? []
    expect(artifactId).toBeDefined()
    // Its own preview: nothing read back for an image uploaded here.
    expect(container.querySelector(`img[alt="screenshot.png"]`)?.getAttribute('src')).toBe(
      'blob:preview-1',
    )
    // Saved with the draft, so a reload or another device has it.
    await act(() => client.drafts!.flush())
    await settle(client)
    expect(client.getState().drafts[PAGE_DRAFT]?.content.artifactIds).toEqual([artifactId])
  })

  it("reads back a draft's image from the environment when this page did not upload it", async () => {
    const client = createMockEnvironmentClient({ seed: SEED })
    // Attached elsewhere: on another device, or before a reload.
    const stored = await client.uploadArtifact!({
      workspaceId: WORKSPACE.workspaceId,
      name: 'from-the-phone.png',
      mimeType: 'image/png',
      bytes: new Blob(['png'], { type: 'image/png' }),
    })
    await client.commands.saveDraft({
      draftId: PAGE_DRAFT,
      baseRevision: 0,
      target: { type: 'new_session', workspaceId: WORKSPACE.workspaceId, sessionId: PAGE_SESSION },
      content: { text: 'what is this?', artifactIds: [stored.artifactId] },
    })
    const fetchArtifact = vi.spyOn(client, 'fetchArtifact')
    await mount(client)

    expect(fetchArtifact).toHaveBeenCalledWith({
      draftId: PAGE_DRAFT,
      artifactId: stored.artifactId,
    })
    expect(textarea().value).toBe('what is this?')
    expect(thumbnails()).toEqual(['Image 1'])
    expect(container.querySelector('img[alt="Image 1"]')?.getAttribute('src')).toMatch(/^blob:/)
  })

  it('holds the send until the images have landed, then sends them by id', async () => {
    const client = createMockEnvironmentClient({ seed: SEED })
    let finish: (() => void) | undefined
    const landed = new Promise<void>((resolve) => {
      finish = resolve
    })
    const { sent } = await mount(client, {
      uploadImage: async (image) => {
        await landed
        return {
          id: 'artifact-1',
          name: image.file.name,
          mimeType: 'image/png',
          size: 3,
          previewUrl: image.previewUrl,
        }
      },
    })
    await attach('screenshot.png')
    await type('look at this')
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull()
    await pressEnter()
    expect(sent).toEqual([])

    await act(async () => {
      finish!()
      await landed
    })
    await settle(client)
    expect(container.querySelector('[aria-busy="true"]')).toBeNull()
    await pressEnter()
    expect(sent).toEqual([
      {
        text: 'look at this',
        attachments: [],
        kept: [{ artifactId: 'artifact-1', name: 'screenshot.png', previewUrl: 'blob:preview-1' }],
      },
    ])
    // Sent: the box and the draft are empty.
    expect(thumbnails()).toEqual([])
    expect(selectDraftContent(client.getState(), PAGE_DRAFT)?.artifactIds).toBeUndefined()
  })

  it('puts the images back with the text when the send fails', async () => {
    const client = createMockEnvironmentClient({ seed: SEED })
    await mount(client, {
      onSend: async () => {
        throw new Error('The provider is unavailable.')
      },
    })
    await attach('screenshot.png')
    await settle(client)
    const images = selectDraftContent(client.getState(), PAGE_DRAFT)?.artifactIds
    expect(images).toHaveLength(1)
    await type('look')
    await pressEnter()
    await settle(client)

    expect(textarea().value).toBe('look')
    expect(selectDraftContent(client.getState(), PAGE_DRAFT)?.artifactIds).toEqual(images)
    expect(thumbnails()).toEqual(['screenshot.png'])
    expect(container.textContent).toContain('The provider is unavailable.')
    // Its own preview still shows: kept for the draft the failed send put back.
    expect(container.querySelector('img[alt="screenshot.png"]')?.getAttribute('src')).toBe(
      'blob:preview-1',
    )
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith('blob:preview-1')
  })

  it('lets go of the previews of images once they are sent', async () => {
    const client = createMockEnvironmentClient({ seed: SEED })
    await mount(client)
    await attach('first.png', 'second.png')
    await settle(client)
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
    await type('look')
    await pressEnter()
    await settle(client)
    expect(thumbnails()).toEqual([])
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview-1')
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview-2')
  })

  it('keeps images in the order they were attached, whichever upload lands first', async () => {
    const client = createMockEnvironmentClient({ seed: SEED })
    const landing = new Map<string, () => void>()
    const { sent } = await mount(client, {
      uploadImage: async (image) => {
        await new Promise<void>((resolve) => landing.set(image.file.name, resolve))
        return {
          id: `artifact-${image.file.name}`,
          name: image.file.name,
          mimeType: 'image/png',
          size: 3,
          previewUrl: image.previewUrl,
        }
      },
    })
    await attach('first.png', 'second.png', 'third.png')
    const land = async (name: string) => {
      await act(async () => landing.get(name)!())
      await settle(client)
    }

    await land('third.png')
    await land('first.png')
    // Still in attach order on screen, with one on its way between them.
    expect(thumbnails()).toEqual(['first.png', 'second.png', 'third.png'])
    await land('second.png')
    expect(selectDraftContent(client.getState(), PAGE_DRAFT)?.artifactIds).toEqual([
      'artifact-first.png',
      'artifact-second.png',
      'artifact-third.png',
    ])
    expect(thumbnails()).toEqual(['first.png', 'second.png', 'third.png'])

    await pressEnter()
    expect(sent[0]?.kept.map((image) => image.artifactId)).toEqual([
      'artifact-first.png',
      'artifact-second.png',
      'artifact-third.png',
    ])
  })

  describe('an image on its way is content', () => {
    const SESSION = { sessionId: 'session-1', workspaceId: WORKSPACE.workspaceId, title: 'First' }
    const WITH_SESSION: MockSeed = {
      workspaces: [WORKSPACE],
      sessions: [
        {
          session: SESSION,
          providerId: 'opencode',
          threads: [{ threadId: 't1', sessionId: SESSION.sessionId }],
        },
      ],
    }
    /** An upload that lands, or fails, when the test says. */
    const slowUpload = () => {
      let land: ((ok: boolean) => void) | undefined
      const outcome = new Promise<boolean>((resolve) => {
        land = resolve
      })
      return {
        land: async (ok = true) => {
          await act(async () => land!(ok))
        },
        uploadImage: async (image: DraftImageAttachment) => {
          if (!(await outcome)) throw new Error('The environment could not be reached.')
          return {
            id: 'artifact-1',
            name: image.file.name,
            mimeType: 'image/png',
            size: 3,
            previewUrl: image.previewUrl,
          }
        },
      }
    }

    for (const [kind, draftKey, draftId] of [
      ['a new-session draft', PAGE_KEY, PAGE_DRAFT],
      ["a session's draft", `session:${SESSION.sessionId}`, SESSION.sessionId],
    ] as const) {
      it(`keeps ${kind} whose text is erased while its image uploads`, async () => {
        const client = createMockEnvironmentClient({ seed: WITH_SESSION })
        const upload = slowUpload()
        await mount(client, { draftKey, uploadImage: upload.uploadImage })
        await type('see attached')
        await act(() => client.drafts!.flush())
        await settle(client)
        expect(client.getState().drafts[draftId]?.content.text).toBe('see attached')

        await attach('screenshot.png')
        // Erased, and written at once, while the image is still on its way.
        await type('')
        await act(() => client.drafts!.flush())
        await settle(client)
        expect(client.calls.some((call) => call.command === 'deleteDraft')).toBe(false)
        expect(thumbnails()).toEqual(['screenshot.png'])

        await upload.land()
        await act(() => client.drafts!.flush())
        await settle(client)
        expect(client.calls.some((call) => call.command === 'deleteDraft')).toBe(false)
        expect(client.getState().drafts[draftId]?.content).toEqual({
          text: '',
          artifactIds: ['artifact-1'],
        })
        expect(thumbnails()).toEqual(['screenshot.png'])
      })
    }

    it('deletes the emptied draft as ever once its only upload fails', async () => {
      const client = createMockEnvironmentClient({ seed: WITH_SESSION })
      const upload = slowUpload()
      await mount(client, { uploadImage: upload.uploadImage })
      await type('see attached')
      await act(() => client.drafts!.flush())
      await settle(client)
      await attach('screenshot.png')
      await type('')
      await act(() => client.drafts!.flush())
      await settle(client)
      expect(client.getState().drafts[PAGE_DRAFT]).toBeDefined()

      await upload.land(false)
      // Held for the image no longer: the pause in typing, then the delete.
      await act(() => new Promise<void>((resolve) => setTimeout(resolve, 1_100)))
      await settle(client)
      expect(client.calls.some((call) => call.command === 'deleteDraft')).toBe(true)
      expect(client.getState().drafts[PAGE_DRAFT]).toBeUndefined()
    })
  })

  it('never brings back a draft that was discarded while its image uploaded', async () => {
    const client = createMockEnvironmentClient({ seed: SEED })
    let finish: (() => void) | undefined
    const slow = new Promise<void>((resolve) => {
      finish = resolve
    })
    await mount(client, {
      uploadImage: async (image) => {
        await slow
        return {
          id: 'artifact-late',
          name: image.file.name,
          mimeType: 'image/png',
          size: 3,
          previewUrl: image.previewUrl,
        }
      },
    })
    await type('half a thought')
    await act(() => client.drafts!.flush())
    await settle(client)
    const saved = client.getState().drafts[PAGE_DRAFT]!
    await attach('screenshot.png')

    // Discarded from the sidebar, as the draft stood, and deleted.
    await act(() => client.drafts!.discard(PAGE_DRAFT, { ifRevision: saved.revision }))
    await settle(client)
    expect(client.getState().drafts[PAGE_DRAFT]).toBeUndefined()
    const saves = client.calls.filter((call) => call.command === 'saveDraft').length

    // The upload lands after: the page still offers the draft's old place,
    // but the deleted draft is not written again.
    await act(async () => {
      finish!()
      await slow
    })
    await settle(client)
    await act(() => client.drafts!.flush())
    await settle(client)
    expect(client.calls.filter((call) => call.command === 'saveDraft')).toHaveLength(saves)
    expect(client.getState().drafts[PAGE_DRAFT]).toBeUndefined()
    expect(selectDraftContent(client.getState(), PAGE_DRAFT)).toBeUndefined()
    expect(thumbnails()).toEqual([])
    expect(container.textContent).toContain('screenshot.png was not attached.')
  })

  it('drops an image from the draft when it is removed, and never names one removed mid-upload', async () => {
    const client = createMockEnvironmentClient({ seed: SEED })
    let finish: (() => void) | undefined
    const slow = new Promise<void>((resolve) => {
      finish = resolve
    })
    let calls = 0
    await mount(client, {
      uploadImage: async (image) => {
        calls += 1
        if (calls === 2) await slow
        return {
          id: `artifact-${calls}`,
          name: image.file.name,
          mimeType: 'image/png',
          size: 3,
          previewUrl: image.previewUrl,
        }
      },
    })
    await attach('first.png')
    await settle(client)
    await attach('second.png')
    expect(thumbnails()).toEqual(['first.png', 'second.png'])

    // Taken out while it uploads: the draft never names it.
    await act(() => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Remove second.png"]')!.click()
    })
    await act(async () => {
      finish!()
      await slow
    })
    await settle(client)
    expect(selectDraftContent(client.getState(), PAGE_DRAFT)?.artifactIds).toEqual(['artifact-1'])

    await act(() => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Remove first.png"]')!.click()
    })
    expect(selectDraftContent(client.getState(), PAGE_DRAFT)?.artifactIds).toBeUndefined()
    expect(thumbnails()).toEqual([])
  })

  it('says so when an upload fails, and keeps nothing of it', async () => {
    const client = createMockEnvironmentClient({ seed: SEED })
    await mount(client, {
      uploadImage: async () => {
        throw new Error('The environment could not be reached.')
      },
    })
    await attach('screenshot.png')
    await settle(client)
    expect(thumbnails()).toEqual([])
    expect(selectDraftContent(client.getState(), PAGE_DRAFT)).toBeUndefined()
    expect(container.textContent).toContain(
      'screenshot.png was not attached. The environment could not be reached.',
    )
  })
})
