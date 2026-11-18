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
import { GeneratedVideoPart } from '../src/components/parts/GeneratedVideoPart'

let container: HTMLDivElement
let root: Root
let artifactId = 0

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  URL.createObjectURL = vi.fn(() => 'blob:whole')
  URL.revokeObjectURL = vi.fn()
  artifactId += 1
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

const settle = () => act(async () => void (await Promise.resolve()))

/** A fresh artifact per test: grants are kept per artifact across mounts. */
const part = (sizeBytes = 1024) => ({
  id: 'a1:artifact',
  artifact: { sessionId: 'session-1', artifactId: `video-${artifactId}` },
  name: 'flow.mp4',
  sizeBytes,
})

function render(client: EnvironmentClient, props = part()) {
  act(() =>
    root.render(
      <EnvironmentClientProvider client={client}>
        <GeneratedVideoPart part={props} />
      </EnvironmentClientProvider>,
    ),
  )
}

const video = () => container.querySelector('video')

describe('a shared video', () => {
  it('plays from a stream grant, never reading the bytes whole', async () => {
    const fetchArtifact = vi.fn()
    const client: EnvironmentClient = {
      ...createMockEnvironmentClient(),
      fetchArtifact,
      artifactStreamUrl: vi.fn(async () => ({ url: 'http://env/media/g1', expiresAt: Date.now() + 3_600_000 })),
    }
    render(client)
    await settle()
    expect(video()?.getAttribute('src')).toBe('http://env/media/g1')
    expect(container.textContent).toContain('flow.mp4')
    expect(fetchArtifact).not.toHaveBeenCalled()
  })

  it('asks again after a failure that may pass, rather than reading it whole', async () => {
    vi.useFakeTimers()
    const fetchArtifact = vi.fn()
    let calls = 0
    const client: EnvironmentClient = {
      ...createMockEnvironmentClient(),
      fetchArtifact,
      artifactStreamUrl: vi.fn(async () => {
        calls += 1
        if (calls === 1) throw new EnvironmentClientError('unavailable', 'Not connected.')
        return { url: 'http://env/media/g2', expiresAt: Date.now() + 3_600_000 }
      }),
    }
    render(client)
    await settle()
    expect(video()).toBeNull()
    expect(container.textContent).not.toContain('unavailable')
    await act(async () => void vi.advanceTimersByTime(1_000))
    await settle()
    expect(video()?.getAttribute('src')).toBe('http://env/media/g2')
    expect(fetchArtifact).not.toHaveBeenCalled()
  })

  it('says it is unavailable when the environment no longer has it', async () => {
    const client: EnvironmentClient = {
      ...createMockEnvironmentClient(),
      artifactStreamUrl: vi.fn(async () => {
        throw new EnvironmentClientError('not_found', 'Artifact not found.')
      }),
    }
    render(client)
    await settle()
    expect(container.textContent).toContain('flow.mp4 is unavailable')
  })

  it('gives up after one renewal that fails the same way, instead of looping', async () => {
    let minted = 0
    const client: EnvironmentClient = {
      ...createMockEnvironmentClient(),
      artifactStreamUrl: vi.fn(async () => {
        minted += 1
        return { url: `http://env/media/g${minted}`, expiresAt: Date.now() + 3_600_000 }
      }),
    }
    render(client)
    await settle()
    act(() => void video()!.dispatchEvent(new Event('error')))
    await settle()
    expect(video()?.getAttribute('src')).toBe('http://env/media/g2')
    act(() => void video()!.dispatchEvent(new Event('error')))
    await settle()
    expect(container.textContent).toContain('cannot be played in this browser')
    expect(minted).toBe(2)
  })

  it('reads a short one whole on a client that cannot stream, and not a long one', async () => {
    const fetchArtifact = vi.fn(async () => new Blob(['bytes']))
    const client: EnvironmentClient = {
      ...createMockEnvironmentClient(),
      fetchArtifact,
      artifactStreamUrl: undefined,
    }
    render(client)
    await settle()
    await settle()
    expect(video()?.getAttribute('src')).toBe('blob:whole')

    artifactId += 1
    render(client, part(500 * 1024 * 1024))
    await settle()
    expect(fetchArtifact).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('is unavailable')
  })
})
