// @vitest-environment jsdom
import { act, useContext } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DeviceHostContext, type DeviceStorage } from '@openmanager/app-core/logic'

import { followUpMenuOf } from '../src/composer/model'
import {
  createComposerUi,
  useCloseWhenGone,
  useComposerUiState,
  type ComposerUi,
} from '../src/composer/ui-state'
import { HydratedDevice, type LoadingDeviceStore } from '../src/storage/device-host'

let root: Root
let host: HTMLElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

const anchor = { x: 0, y: 0, width: 36, height: 36 }

/** The surface's part that matters here: the menu's state follows its choice. */
function Surface({ ui, offered }: { ui: ComposerUi; offered: boolean }) {
  const { overlay } = useComposerUiState(ui)
  useCloseWhenGone(ui, overlay, 'followUp', offered)
  return null
}

describe('the send menu', () => {
  it('is offered only while the button queues or steers and the other is possible', () => {
    expect(followUpMenuOf({ kind: 'steer', alternate: 'queue' })).toEqual(['steer', 'queue'])
    expect(followUpMenuOf({ kind: 'queue', alternate: null })).toBeNull()
    expect(followUpMenuOf({ kind: 'send', alternate: null })).toBeNull()
    expect(followUpMenuOf({ kind: 'stop', alternate: null })).toBeNull()
  })

  it('closes when the turn ends under it, so the page is not left covered', () => {
    const ui = createComposerUi()
    act(() => root.render(<Surface ui={ui} offered />))
    act(() => ui.open({ kind: 'followUp', anchor }))
    expect(ui.get().overlay?.kind).toBe('followUp')

    // The turn ends: the button is Send again, the choice is gone.
    act(() => root.render(<Surface ui={ui} offered={false} />))
    expect(ui.get().overlay).toBeNull()
  })

  it('leaves any other overlay alone', () => {
    const ui = createComposerUi()
    act(() => root.render(<Surface ui={ui} offered={false} />))
    act(() => ui.open({ kind: 'model' }))
    act(() => root.render(<Surface ui={ui} offered={false} />))
    expect(ui.get().overlay).toEqual({ kind: 'model' })
  })
})

describe('the device storage outside an environment', () => {
  function fakeStore() {
    const saved = new Map<string, string>()
    let release!: () => void
    const loaded = new Promise<void>((resolve) => (release = resolve))
    let hydrated = false
    const store = {
      get hydrated() {
        return hydrated
      },
      device: {
        getItem: (key: string) => saved.get(key) ?? null,
        setItem: (key: string, value: string) => void saved.set(key, value),
        removeItem: (key: string) => void saved.delete(key),
      },
      hydrate: () => loaded,
      release: () => {
        hydrated = true
        release()
      },
    } satisfies LoadingDeviceStore & { release: () => void }
    return store
  }

  let seen: DeviceStorage | null | undefined
  function Probe() {
    seen = useContext(DeviceHostContext).storage
    return <span>choice</span>
  }

  it('holds a setting until the storage has loaded, then hands it the store', async () => {
    const store = fakeStore()
    seen = undefined
    act(() =>
      root.render(
        <HydratedDevice store={store} hold>
          <Probe />
        </HydratedDevice>,
      ),
    )
    // Nothing to change yet: a choice made now would be dropped.
    expect(host.textContent).toBe('')
    await act(async () => store.release())
    expect(host.textContent).toBe('choice')
    expect(seen).toBe(store.device)
  })

  it('gives readers no storage before the load, so they read their defaults', async () => {
    const store = fakeStore()
    seen = undefined
    act(() =>
      root.render(
        <HydratedDevice store={store}>
          <Probe />
        </HydratedDevice>,
      ),
    )
    expect(host.textContent).toBe('choice')
    expect(seen).toBeNull()
    await act(async () => store.release())
    expect(seen).toBe(store.device)
  })

  it("offers the setting once boot's retry lands after a failed load", async () => {
    vi.useFakeTimers()
    try {
      const store = fakeStore()
      let hydrated = false
      const failing = {
        ...store,
        get hydrated() {
          return hydrated
        },
        hydrate: () => Promise.reject(new Error('disk busy')),
      } satisfies LoadingDeviceStore
      act(() =>
        root.render(
          <HydratedDevice store={failing} hold>
            <Probe />
          </HydratedDevice>,
        ),
      )
      await act(async () => {
        await Promise.resolve()
      })
      expect(host.textContent).toBe('')
      // Boot retries on its own and succeeds; the open page notices.
      hydrated = true
      await act(async () => {
        vi.advanceTimersByTime(600)
      })
      expect(host.textContent).toBe('choice')
    } finally {
      vi.useRealTimers()
    }
  })
})
