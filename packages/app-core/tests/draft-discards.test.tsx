// @vitest-environment jsdom
import { act, useImperativeHandle, type Ref } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createInitialState,
  type DraftSync,
  type EnvironmentClient,
} from '@openmanager/environment-client'
import { useDraftDiscards, type DraftDiscards } from '../src/providers/environment-sidebar-drafts'

const REVISION = 3

/** A client with a saved draft, keeping only what a discard reaches for. */
function clientWith(environmentId: string) {
  const state = {
    ...createInitialState(),
    environment: { environmentId, name: environmentId },
    drafts: { d: { draftId: 'd', revision: REVISION } },
  }
  const discard = vi.fn<DraftSync['discard']>()
  const client = {
    getState: () => state,
    subscribe: () => () => undefined,
    drafts: { discard, pinAnswer: () => () => undefined },
  } as unknown as EnvironmentClient
  return { client, discard }
}

function Host({
  latest,
  handle,
}: {
  latest: (environmentId: string) => EnvironmentClient | undefined
  handle: Ref<DraftDiscards>
}) {
  const discards = useDraftDiscards(latest)
  useImperativeHandle(handle, () => discards, [discards])
  return null
}

let root: Root
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  root = createRoot(document.createElement('div'))
})
afterEach(async () => {
  await act(async () => root.unmount())
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function mount(latest: (environmentId: string) => EnvironmentClient | undefined) {
  const handle: { current: DraftDiscards | null } = { current: null }
  await act(async () => root.render(<Host latest={latest} handle={handle} />))
  return handle
}

describe('a discard waiting out its undo window', () => {
  it('goes through the client that replaced the one it was made on', async () => {
    const before = clientWith('env-a')
    const after = clientWith('env-a')
    let current = before.client
    const discards = await mount(() => current)

    await act(async () => void discards.current!.begin(before.client, 'd'))
    // A new route to the same environment, inside the window.
    current = after.client
    await act(async () => vi.advanceTimersByTime(6_000))

    expect(after.discard).toHaveBeenCalledWith('d', { ifRevision: REVISION })
    expect(before.discard).not.toHaveBeenCalled()
  })

  it('names the revision it was made on, whatever the replacement has seen', async () => {
    const before = clientWith('env-a')
    const after = clientWith('env-a')
    const discards = await mount(() => after.client)

    await act(async () => void discards.current!.begin(before.client, 'd'))
    await act(async () => discards.current!.confirm())

    expect(after.discard).toHaveBeenCalledTimes(1)
    expect(after.discard.mock.calls[0]![1]).toEqual({ ifRevision: REVISION })
  })

  it('falls back on the client it was made on once the environment has none', async () => {
    const only = clientWith('env-a')
    const discards = await mount(() => undefined)

    await act(async () => void discards.current!.begin(only.client, 'd'))
    await act(async () => discards.current!.confirm())

    expect(only.discard).toHaveBeenCalledWith('d', { ifRevision: REVISION })
  })
})
