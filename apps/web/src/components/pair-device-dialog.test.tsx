import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createMockEnvironmentClient,
  parsePairingLink,
  type AuthorizedClient,
  type MockEnvironmentClient,
} from '@openmanager/environment-client'
import { EnvironmentClientProvider } from '@openmanager/app-core/providers/environment-client'
import type { EnvironmentRoute } from '../lib/environment-store'
import { DevicesSettingControl, type PairingTarget } from './devices-settings'
import { defaultPairingRoute, formatRemaining } from './pair-device-dialog'

afterEach(() => {
  cleanup()
})

const route = (endpoint: string, priority = 0): EnvironmentRoute => ({
  type: 'remote',
  endpoint,
  priority,
  health: { status: 'unknown' },
})

const TUNNEL = 'https://desk.tunnel.example'
const LOCAL = 'http://127.0.0.1:43120'

function renderDevices(client: MockEnvironmentClient, pairing: Partial<PairingTarget> = {}) {
  render(
    <EnvironmentClientProvider client={client}>
      <DevicesSettingControl
        section={(body) => <section>{body}</section>}
        pairing={{
          environmentId: 'env-desk',
          routes: [route(TUNNEL)],
          inUseEndpoint: TUNNEL,
          appUrl: 'https://app.example/',
          ...pairing,
        }}
      />
    </EnvironmentClientProvider>,
  )
}

async function openPairing(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Pair a device' }))
  return screen.findByRole('dialog', { name: 'Pair a device' })
}

/** The link the dialog shows, read back as the new device would. */
function shownLink() {
  const value = (screen.getByRole('textbox', { name: 'Pairing link' }) as HTMLInputElement).value
  const parsed = parsePairingLink(value)
  if (!parsed.ok) throw new Error(`not a pairing link: ${value}`)
  return { url: value, payload: parsed.payload }
}

describe('pair a device', () => {
  it('makes a link with the chosen access and shows it as a QR code and a link', async () => {
    const user = userEvent.setup()
    const client = createMockEnvironmentClient()
    renderDevices(client)
    const dialog = await openPairing(user)

    // Full access is the default, and says it runs code; Manage access is its own tick.
    expect(within(dialog).getByRole('checkbox', { name: /^Run agents/ })).toBeChecked()
    expect(within(dialog).getByRole('checkbox', { name: /^Manage access/ })).not.toBeChecked()
    expect(within(dialog).getByText(/Runs code on this machine/)).toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: 'View only' }))
    expect(within(dialog).queryByText(/Runs code on this machine/)).toBeNull()
    await user.type(within(dialog).getByRole('textbox', { name: /Device name/ }), 'Pixel')
    await user.click(within(dialog).getByRole('button', { name: 'Create link' }))

    expect(await within(dialog).findByRole('img', { name: 'Pairing QR code' })).toBeInTheDocument()
    const { url, payload } = shownLink()
    expect(url.startsWith('https://app.example/pair#')).toBe(true)
    expect(payload).toMatchObject({ route: TUNNEL, environmentId: 'env-desk' })
    expect(client.calls.find((call) => call.command === 'createPairingLink')?.input).toEqual({
      capabilities: ['read'],
      label: 'Pixel',
    })
    expect(within(dialog).getByRole('status')).toHaveTextContent(
      /Waiting for a device · expires in [45]:\d\d/,
    )
  })

  it('says which device used the link once it pairs', async () => {
    const user = userEvent.setup()
    const client = createMockEnvironmentClient()
    renderDevices(client)
    const dialog = await openPairing(user)
    await user.click(within(dialog).getByRole('button', { name: 'Create link' }))
    await within(dialog).findByRole('img', { name: 'Pairing QR code' })

    client.pairDevice(shownLink().payload.token, 'Chrome on Android')

    expect(await within(dialog).findByRole('heading', { name: 'Device paired' })).toBeVisible()
    expect(
      within(dialog).getByText(/Chrome on Android can now reach this environment/),
    ).toBeVisible()
    // The device list behind the dialog has it too.
    expect(
      screen.getByRole('listitem', { name: 'Chrome on Android', hidden: true }),
    ).toBeInTheDocument()
  })

  it('withdraws a link so nobody can use it', async () => {
    const user = userEvent.setup()
    const client = createMockEnvironmentClient()
    renderDevices(client)
    const dialog = await openPairing(user)
    await user.click(within(dialog).getByRole('button', { name: 'Create link' }))
    await within(dialog).findByRole('img', { name: 'Pairing QR code' })
    const { token } = shownLink().payload

    await user.click(within(dialog).getByRole('button', { name: 'Withdraw link' }))
    expect(await within(dialog).findByRole('heading', { name: 'Link withdrawn' })).toBeVisible()
    expect(() => client.pairDevice(token)).toThrow(
      expect.objectContaining({ details: { reason: 'invalid' } }),
    )
  })

  it('offers only what this device holds, and warns when the link only works here', async () => {
    const user = userEvent.setup()
    const manager: AuthorizedClient = {
      clientId: 'client-laptop',
      label: 'Laptop',
      kind: 'paired',
      capabilities: ['read', 'operate', 'admin'],
      createdAt: '2026-10-01T10:00:00.000Z',
      lastSeenAt: null,
      expiresAt: '2026-11-01T10:00:00.000Z',
      connected: true,
    }
    const client = createMockEnvironmentClient({
      seed: { authorizedClients: [manager], currentClientId: 'client-laptop' },
    })
    renderDevices(client, {
      routes: [route(LOCAL)],
      inUseEndpoint: LOCAL,
      appUrl: 'http://localhost:5173/',
    })
    const dialog = await openPairing(user)

    expect(within(dialog).queryByRole('checkbox', { name: /^Run agents/ })).toBeNull()
    expect(within(dialog).queryByRole('button', { name: 'Full access' })).toBeNull()
    // Full access is not offered, but as much of it as this device holds is the default.
    expect(within(dialog).getByRole('checkbox', { name: /^Edit/ })).toBeChecked()
    expect(within(dialog).getByText(/which only works on this computer/)).toBeInTheDocument()
    expect(within(dialog).getByText(/the link opens only on this computer/)).toBeInTheDocument()
  })

  it('is not offered to a device that cannot manage access', async () => {
    const viewer: AuthorizedClient = {
      clientId: 'client-viewer',
      label: 'Viewer',
      kind: 'paired',
      capabilities: ['read'],
      createdAt: '2026-10-01T10:00:00.000Z',
      lastSeenAt: null,
      expiresAt: '2026-11-01T10:00:00.000Z',
      connected: true,
    }
    const client = createMockEnvironmentClient({
      seed: { authorizedClients: [viewer], currentClientId: 'client-viewer' },
    })
    renderDevices(client)
    await waitFor(() => expect(screen.getByText(/cannot manage access/)).toBeVisible())
    expect(screen.queryByRole('button', { name: 'Pair a device' })).toBeNull()
  })
})

describe('defaultPairingRoute', () => {
  it('prefers an address another device can reach', () => {
    expect(defaultPairingRoute([route(LOCAL), route(TUNNEL, 1)], LOCAL)).toBe(TUNNEL)
    expect(defaultPairingRoute([route(TUNNEL)], TUNNEL)).toBe(TUNNEL)
    expect(defaultPairingRoute([route(LOCAL)], LOCAL)).toBe(LOCAL)
    expect(defaultPairingRoute([], null)).toBeNull()
  })
})

describe('formatRemaining', () => {
  it('counts down in minutes and seconds, then stops', () => {
    const now = Date.parse('2026-10-04T12:00:00.000Z')
    expect(formatRemaining('2026-10-04T12:05:00.000Z', now)).toBe('5:00')
    expect(formatRemaining('2026-10-04T12:00:09.500Z', now)).toBe('0:10')
    expect(formatRemaining('2026-10-04T12:00:00.000Z', now)).toBeNull()
  })
})
