// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { act, useContext } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createMockEnvironmentClient, type EnvironmentClient } from '@openmanager/environment-client'
import {
  ComposerDraftStoreContext,
  type ComposerDraftStore,
} from '../src/components/chat/composerDraftStore'
import { EnvironmentClientProvider } from '../src/providers/environment-client'
import { EnvironmentComposerDraftProvider } from '../src/providers/environment-drafts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
afterEach(() => {
  act(() => root?.unmount())
  root = undefined
})

function renderStores() {
  const stores: Array<ComposerDraftStore | null> = []
  function Capture() {
    stores.push(useContext(ComposerDraftStoreContext))
    return null
  }
  root = createRoot(document.createElement('div'))
  const show = (client: EnvironmentClient) =>
    act(() =>
      root!.render(
        <EnvironmentClientProvider client={client}>
          <EnvironmentComposerDraftProvider importLocal={false}>
            <Capture />
          </EnvironmentComposerDraftProvider>
        </EnvironmentClientProvider>,
      ),
    )
  return { stores, show }
}

describe('EnvironmentComposerDraftProvider', () => {
  it('keeps its store when the same environment hands over a new client object', () => {
    const client = createMockEnvironmentClient()
    const { stores, show } = renderStores()

    show({ ...client })
    show(client)

    expect(stores.at(-1)).toBe(stores[0])
    expect(stores[0]).not.toBeNull()
  })

  it('starts a new store for another client', () => {
    const { stores, show } = renderStores()

    show(createMockEnvironmentClient())
    show(createMockEnvironmentClient())

    expect(stores.at(-1)).not.toBe(stores[0])
  })
})
