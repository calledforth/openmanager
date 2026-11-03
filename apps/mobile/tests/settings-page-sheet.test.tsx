// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createMockEnvironmentClient,
  type AuthorizedClient,
  type MockEnvironmentClient,
} from '@openmanager/environment-client'

import { forgetMadeLinks, type DeviceAdminState } from '../src/settings/device-admin'
import { sheetSubjectPresent, usePageSheet, type PageSheet } from '../src/settings/page-sheet'
import { useDeviceAdmin } from '../src/settings/useSettingsStores'

const LATER = new Date(Date.now() + 30 * 86_400_000).toISOString()
const FULL = ['read', 'operate', 'agent', 'terminal', 'admin'] as const
const device = (clientId: string, label: string, kind: AuthorizedClient['kind'] = 'paired') =>
  ({
    clientId,
    label,
    kind,
    capabilities: [...FULL],
    createdAt: new Date().toISOString(),
    lastSeenAt: null,
    expiresAt: LATER,
    connected: false,
  }) satisfies AuthorizedClient
const OWNER = device('client-owner', 'Desktop app', 'owner')
const PHONE = device('client-phone', 'Pixel 9')
const LAPTOP = device('client-laptop', 'Laptop')

let container: HTMLDivElement
let root: Root
const clients: MockEnvironmentClient[] = []
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(() => root.unmount())
  container.remove()
  for (const client of clients.splice(0)) client.dispose()
  forgetMadeLinks()
  vi.unstubAllGlobals()
})
const flush = async (rounds = 8) => {
  for (let round = 0; round < rounds; round += 1) {
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
  }
}

let seen: PageSheet | null = null
let open: (sheet: PageSheet | null) => void = () => undefined
/** The environment page's sheet state, over the real device store, as the page wires it. */
function Page({ client, appUrl }: { client: MockEnvironmentClient; appUrl: string | null }) {
  const [, state] = useDeviceAdmin(client, 'env')
  const [sheet, setSheet] = usePageSheet(state, { appUrl, titlesRead: false })
  seen = sheet
  open = setSheet
  return null
}

async function mount(appUrl: string | null = 'https://app.example.test') {
  const client = createMockEnvironmentClient({
    seed: { authorizedClients: [OWNER, PHONE, LAPTOP], currentClientId: PHONE.clientId },
  })
  clients.push(client)
  await act(() => root.render(<Page client={client} appUrl={appUrl} />))
  await flush()
  return client
}

describe('the environment page’s sheet', () => {
  it('closes a device’s sheet when the environment says the device was revoked elsewhere', async () => {
    const client = await mount()
    await act(() => open({ kind: 'device', clientId: LAPTOP.clientId }))
    expect(seen).toEqual({ kind: 'device', clientId: LAPTOP.clientId })
    // Another admin revokes it: the environment's push removes it from the list.
    await act(() => client.commands.revokeAuthorizedClient(LAPTOP.clientId))
    await flush()
    expect(seen).toBeNull()
  })

  it('closes the revoke question too, once its device is gone', async () => {
    const client = await mount()
    await act(() =>
      open({
        kind: 'confirm',
        confirm: { kind: 'revoke', clientId: LAPTOP.clientId, label: LAPTOP.label },
      }),
    )
    expect(seen?.kind).toBe('confirm')
    await act(() => client.commands.revokeAuthorizedClient(LAPTOP.clientId))
    await flush()
    expect(seen).toBeNull()
  })

  it('keeps a sheet whose subject is still there, and never opens pairing without an app address', async () => {
    const client = await mount(null)
    await act(() => open({ kind: 'device', clientId: LAPTOP.clientId }))
    await act(() => client.commands.renameAuthorizedClient(LAPTOP.clientId, 'Work laptop'))
    await flush()
    expect(seen).toEqual({ kind: 'device', clientId: LAPTOP.clientId })
    await act(() => open({ kind: 'pair', reopen: null }))
    expect(seen).toBeNull()
  })

  it('decides by what the environment last reported', () => {
    const state: DeviceAdminState = {
      list: { clients: [OWNER, PHONE], currentClientId: PHONE.clientId, omitted: 0 },
      access: 'admin',
      loadError: null,
      links: [],
      linksError: null,
      busy: null,
      actionError: null,
      failed: null,
      connected: true,
    }
    const context = { appUrl: 'https://app.example.test', titlesRead: false }
    expect(sheetSubjectPresent({ kind: 'forget' }, null, context)).toBe(true)
    expect(sheetSubjectPresent({ kind: 'titles' }, state, context)).toBe(false)
    expect(sheetSubjectPresent({ kind: 'device', clientId: 'gone' }, state, context)).toBe(false)
    expect(sheetSubjectPresent({ kind: 'pair', reopen: null }, state, context)).toBe(true)
    // This phone's own row gone (it was revoked): nothing to pair from.
    expect(
      sheetSubjectPresent(
        { kind: 'pair', reopen: null },
        { ...state, list: { ...state.list!, clients: [OWNER] } },
        context,
      ),
    ).toBe(false)
    // This phone's own revoke in flight keeps its question until the answer.
    expect(
      sheetSubjectPresent(
        { kind: 'confirm', confirm: { kind: 'revoke', clientId: 'gone', label: 'x' } },
        { ...state, busy: { kind: 'revoke', clientId: 'gone' } },
        context,
      ),
    ).toBe(true)
  })
})
