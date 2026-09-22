// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  EnvironmentClientError,
  createMockEnvironmentClient,
  type EnvironmentClient,
} from '@openmanager/environment-client'
import { EnvironmentClientProvider } from '../src/providers/environment-client'
import { ARTIFACT_PREVIEW_IDLE_MS } from '../src/lib/artifact-preview'
import { UserMessage } from '../src/components/chat/UserMessage'
import { GeneratedImagePart } from '../src/components/parts/GeneratedImagePart'

const ARTIFACT = { sessionId: 'session-1', artifactId: 'artifact-1' }

let container: HTMLDivElement
let root: Root
let minted: string[]
let revoked: string[]

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  minted = []
  revoked = []
  // jsdom has neither; the preview only needs a stable string per blob.
  URL.createObjectURL = vi.fn(() => {
    const url = `blob:preview-${minted.length + 1}`
    minted.push(url)
    return url
  })
  URL.revokeObjectURL = vi.fn((url: string) => void revoked.push(url))
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

/** A client whose artifact reads are counted and settled by the test. */
function countingClient(read: EnvironmentClient['fetchArtifact']) {
  const calls: unknown[] = []
  const client: EnvironmentClient = {
    ...createMockEnvironmentClient(),
    fetchArtifact: (input, init) => {
      calls.push(input)
      return read!(input, init)
    },
  }
  return { client, calls }
}

const settle = () => act(async () => void (await Promise.resolve()))

describe('artifact previews', () => {
  it('shows an attached image once its bytes arrive, and opens it full size', async () => {
    const { client, calls } = countingClient(async () => new Blob(['png'], { type: 'image/png' }))
    act(() =>
      root.render(
        <EnvironmentClientProvider client={client}>
          <UserMessage
            content="what is this?"
            parts={[{ type: 'image', id: 'p1', artifact: ARTIFACT, name: 'screenshot.png' }]}
          />
        </EnvironmentClientProvider>,
      ),
    )
    // Nothing to put in `src` yet: the row holds a placeholder, not a broken image.
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('[aria-label="Loading screenshot.png"]')).not.toBeNull()

    await settle()
    expect(calls).toEqual([ARTIFACT])
    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:preview-1')

    act(() => container.querySelector<HTMLButtonElement>('button[aria-label^="Preview"]')!.click())
    expect(document.querySelector('[role="dialog"] img')?.getAttribute('src')).toBe(
      'blob:preview-1',
    )
  })

  it('reads an artifact once however many rows show it, then lets the URL go', async () => {
    vi.useFakeTimers()
    const { client, calls } = countingClient(async () => new Blob(['png'], { type: 'image/png' }))
    const part = { type: 'image', id: 'p1', artifact: ARTIFACT, name: 'a.png', generated: true }
    act(() =>
      root.render(
        <EnvironmentClientProvider client={client}>
          {/* The optimistic echo and the generated copy of the same bytes. */}
          <UserMessage
            content=""
            optimisticAttachments={[{ id: 'artifact-1', name: 'a.png', artifact: ARTIFACT }]}
          />
          <GeneratedImagePart part={part} />
        </EnvironmentClientProvider>,
      ),
    )
    await settle()
    expect(calls).toHaveLength(1)
    expect([...container.querySelectorAll('img')].map((img) => img.getAttribute('src'))).toEqual([
      'blob:preview-1',
      'blob:preview-1',
    ])

    act(() =>
      root.render(<EnvironmentClientProvider client={client}>{null}</EnvironmentClientProvider>),
    )
    expect(revoked).toEqual([])
    act(() => vi.advanceTimersByTime(ARTIFACT_PREVIEW_IDLE_MS))
    expect(revoked).toEqual(['blob:preview-1'])
  })

  it('says the image is unavailable when the environment refuses the read', async () => {
    const { client } = countingClient(async () => {
      throw new EnvironmentClientError('auth', 'A valid client credential is required.')
    })
    act(() =>
      root.render(
        <EnvironmentClientProvider client={client}>
          <GeneratedImagePart part={{ id: 'p1', artifact: ARTIFACT, name: 'render.png' }} />
        </EnvironmentClientProvider>,
      ),
    )
    await settle()
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('render.png is unavailable')
    expect(minted).toEqual([])
  })

  it('never asks a host that has no artifact route', async () => {
    const client: EnvironmentClient = { ...createMockEnvironmentClient(), fetchArtifact: undefined }
    act(() =>
      root.render(
        <EnvironmentClientProvider client={client}>
          <GeneratedImagePart part={{ id: 'p1', artifact: ARTIFACT, name: 'render.png' }} />
        </EnvironmentClientProvider>,
      ),
    )
    await settle()
    expect(container.textContent).toContain('render.png is unavailable')
  })

  it('keeps showing a part that already carries its own URL', () => {
    const { client, calls } = countingClient(async () => new Blob())
    act(() =>
      root.render(
        <EnvironmentClientProvider client={client}>
          <GeneratedImagePart part={{ id: 'p1', url: 'data:image/png;base64,AAAA', name: 'x' }} />
        </EnvironmentClientProvider>,
      ),
    )
    expect(container.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AAAA')
    expect(calls).toEqual([])
  })
})
