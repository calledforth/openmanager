import { PROTOCOL_VERSION } from '@openmanager/protocol'
import { cleanup, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createMockEnvironmentClient,
  encodePairingLink,
  type MockEnvironmentClient,
} from '@openmanager/environment-client'
import type { ComponentProps } from 'react'
import type { WebApp } from './app'
import { environmentSocketUrl } from './lib/environment-socket'
import { ENVIRONMENT_STORAGE_KEY } from './lib/environment-store'
import { renderWebApp } from './test-utils'

type CreateClient = ComponentProps<typeof WebApp>['createEnvironmentClient']

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const ROUTE = 'https://desk.tunnel.example'
const LAN = 'https://lan.example'
const TOKEN = 'ABCDEFGHJKMN'
const CREDENTIAL = `omc1.${'p'.repeat(43)}`

const pairPath = (payload: { route?: string; environmentId?: string; token?: string } = {}) => {
  const url = new URL(
    encodePairingLink('https://app.example/', {
      route: ROUTE,
      environmentId: 'env-desk',
      token: TOKEN,
      ...payload,
    }),
  )
  return `${url.pathname}${url.hash}`
}

/**
 * The environment at the link's route: `/bootstrap` says who it is and
 * `POST /pair` answers with `pair`'s status and body.
 */
function mockEnvironment(pair: { status: number; body: unknown } | null) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/pair') && init?.method === 'POST') {
      if (!pair) throw new Error('No pairing expected')
      return new Response(JSON.stringify(pair.body), { status: pair.status })
    }
    return new Response(
      JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: ['connection.heartbeat'],
        environmentId: 'env-desk',
        label: 'Desk',
      }),
      { status: 200 },
    )
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const pairPosts = (fetchMock: ReturnType<typeof mockEnvironment>) =>
  fetchMock.mock.calls.filter(([input, init]) => String(input).endsWith('/pair') && init?.method)

const LINK = {
  linkId: 'link-1',
  label: null,
  capabilities: ['read' as const, 'operate' as const],
  createdByClientId: 'client-owner',
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
  status: 'waiting' as const,
  usedByClientId: null,
  usedAt: null,
}

/** The environment as a phone paired earlier sees it, with a link waiting for it. */
const pairedPhone = (environmentId: string) =>
  createMockEnvironmentClient({
    seed: {
      environment: { environmentId, name: 'Desk' },
      authorizedClients: [
        {
          clientId: 'client-owner',
          label: 'Local owner',
          kind: 'owner',
          capabilities: ['read', 'operate', 'agent', 'terminal', 'admin'],
          createdAt: '2026-10-01T10:00:00.000Z',
          lastSeenAt: null,
          expiresAt: '2099-11-01T10:00:00.000Z',
          connected: true,
        },
        {
          clientId: 'client-phone',
          label: 'Pixel',
          kind: 'paired',
          capabilities: ['read'],
          createdAt: '2026-10-01T10:00:00.000Z',
          lastSeenAt: null,
          expiresAt: '2026-11-01T10:00:00.000Z',
          connected: true,
        },
      ],
      currentClientId: 'client-phone',
      pairingLinks: [{ link: LINK, token: TOKEN }],
    },
  })

/** Sockets the shell opens, and the token each carried. */
function trackClients(seed?: (environmentId: string) => MockEnvironmentClient) {
  const dialled: Array<{ url: string; credential: string | undefined }> = []
  const clients: MockEnvironmentClient[] = []
  const create: CreateClient = (options) => {
    dialled.push({ url: options.url, credential: options.credential })
    const environmentId = options.environmentId ?? 'env-desk'
    const client =
      seed?.(environmentId) ??
      createMockEnvironmentClient({
        seed: { environment: { environmentId, name: 'Desk' } },
      })
    clients.push(client)
    return client
  }
  return { dialled, clients, create }
}

/**
 * The shell swaps in the connected layout once the saved environment's socket
 * is up, which remounts the page; a click before that lands on the old one.
 */
const connectedShell = () => screen.findByRole('button', { name: 'Add project' })

function stored() {
  return JSON.parse(localStorage.getItem(ENVIRONMENT_STORAGE_KEY) ?? '{}') as {
    selectedId: string | null
    environments: Array<{
      environmentId: string
      label: string
      credential: string
      routes: Array<{ endpoint: string }>
    }>
  }
}

describe('pairing a browser from a link', () => {
  it('trades the token for its own credential, saves it and lands in the session list', async () => {
    const user = userEvent.setup()
    const fetchMock = mockEnvironment({
      status: 200,
      body: {
        environmentId: 'env-desk',
        label: 'Desk',
        kind: 'paired',
        clientId: 'client-phone',
        clientLabel: 'Pixel',
        grant: ['read', 'operate'],
        credential: CREDENTIAL,
      },
    })
    const sockets = trackClients()
    const { router } = renderWebApp(pairPath(), { createEnvironmentClient: sockets.create })

    expect(await screen.findByRole('heading', { name: 'Pair this browser' })).toBeVisible()
    expect(screen.getByText('desk.tunnel.example')).toBeVisible()
    // The token leaves the address bar before anything is sent.
    await waitFor(() => expect(router.state.location.hash).toBe(''))
    expect(pairPosts(fetchMock)).toHaveLength(0)

    const name = screen.getByRole('textbox', { name: 'Name for this browser' })
    await user.clear(name)
    await user.type(name, 'Pixel')
    await user.click(screen.getByRole('button', { name: 'Pair this browser' }))

    await waitFor(() => expect(router.state.location.pathname).toBe('/'))
    const [, init] = pairPosts(fetchMock)[0]!
    expect(JSON.parse(String(init!.body))).toEqual({ token: TOKEN, label: 'Pixel' })
    expect(stored()).toMatchObject({
      selectedId: 'env-desk',
      environments: [
        {
          environmentId: 'env-desk',
          label: 'Desk',
          credential: CREDENTIAL,
          routes: [{ endpoint: ROUTE }],
        },
      ],
    })
    await waitFor(() =>
      expect(sockets.dialled).toContainEqual({
        url: environmentSocketUrl(ROUTE),
        credential: CREDENTIAL,
      }),
    )
  })

  it('keeps a credential another tab saved while this one held a record without one', async () => {
    const user = userEvent.setup()
    const registry = (credential?: string) =>
      JSON.stringify({
        version: 2,
        selectedId: 'env-desk',
        environments: [
          {
            environmentId: 'env-desk',
            label: 'Desk',
            ...(credential ? { credential } : {}),
            routes: [{ type: 'remote', endpoint: LAN, priority: 0 }],
          },
        ],
      })
    localStorage.setItem(ENVIRONMENT_STORAGE_KEY, registry())
    mockEnvironment({
      status: 200,
      body: {
        environmentId: 'env-desk',
        label: 'Desk',
        kind: 'paired',
        clientId: 'client-phone',
        clientLabel: 'Pixel',
        grant: ['read'],
        credential: CREDENTIAL,
      },
    })
    renderWebApp(pairPath())
    await screen.findByRole('heading', { name: 'Pair this browser' })
    await connectedShell()

    const theirs = `omc1.${'t'.repeat(43)}`
    localStorage.setItem(ENVIRONMENT_STORAGE_KEY, registry(theirs))
    await user.click(screen.getByRole('button', { name: 'Pair this browser' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /paired with the environment from another tab/,
    )
    expect(stored().environments[0]!.credential).toBe(theirs)
  })

  it('says why a link was refused and saves nothing', async () => {
    const user = userEvent.setup()
    mockEnvironment({
      status: 401,
      body: {
        type: 'error',
        requestId: null,
        error: { code: 'auth', message: 'Expired.', details: { reason: 'expired' } },
      },
    })
    renderWebApp(pairPath())
    await user.click(await screen.findByRole('button', { name: 'Pair this browser' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/This pairing link expired/)
    expect(localStorage.getItem(ENVIRONMENT_STORAGE_KEY)).toBeNull()
  })

  it('keeps nothing when the route answers as another environment than the link names', async () => {
    const user = userEvent.setup()
    mockEnvironment({
      status: 200,
      body: {
        environmentId: 'env-elsewhere',
        label: 'Elsewhere',
        kind: 'paired',
        clientId: 'client-phone',
        clientLabel: 'Pixel',
        grant: ['read'],
        credential: CREDENTIAL,
      },
    })
    renderWebApp(pairPath())
    await user.click(await screen.findByRole('button', { name: 'Pair this browser' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/different environment/)
    expect(localStorage.getItem(ENVIRONMENT_STORAGE_KEY)).toBeNull()
  })

  it('redeems over its own connection when it already has a credential for the environment', async () => {
    const user = userEvent.setup()
    const saved = `omc1.${'s'.repeat(43)}`
    localStorage.setItem(
      ENVIRONMENT_STORAGE_KEY,
      JSON.stringify({
        version: 2,
        selectedId: 'env-desk',
        environments: [
          {
            environmentId: 'env-desk',
            label: 'Desk',
            credential: saved,
            routes: [{ type: 'remote', endpoint: LAN, priority: 0 }],
          },
        ],
      }),
    )
    const fetchMock = mockEnvironment(null)
    const sockets = trackClients(pairedPhone)
    const { router } = renderWebApp(pairPath(), { createEnvironmentClient: sockets.create })

    expect(await screen.findByRole('heading', { name: 'Pair again with Desk' })).toBeVisible()
    await connectedShell()
    await user.click(screen.getByRole('button', { name: 'Update access' }))

    await waitFor(() => expect(router.state.location.pathname).toBe('/'))
    const redeemed = sockets.clients.flatMap((client) =>
      client.calls.filter((call) => call.command === 'redeemPairingLink'),
    )
    expect(redeemed).toEqual([{ command: 'redeemPairingLink', input: { token: TOKEN } }])
    // Redeemed on the socket to the saved route with the saved token; nothing
    // went to the address the link names.
    expect(pairPosts(fetchMock)).toHaveLength(0)
    expect(sockets.dialled).not.toContainEqual(
      expect.objectContaining({ url: environmentSocketUrl(ROUTE) }),
    )
    expect(sockets.dialled.every((item) => item.credential === saved)).toBe(true)
    expect(stored().environments).toEqual([
      expect.objectContaining({
        credential: saved,
        routes: [expect.objectContaining({ endpoint: LAN })],
      }),
    ])
  })

  it('selects the saved environment first when another one is in use', async () => {
    const user = userEvent.setup()
    const saved = `omc1.${'s'.repeat(43)}`
    localStorage.setItem(
      ENVIRONMENT_STORAGE_KEY,
      JSON.stringify({
        version: 2,
        selectedId: null,
        environments: [
          {
            environmentId: 'env-desk',
            label: 'Desk',
            credential: saved,
            routes: [{ type: 'remote', endpoint: LAN, priority: 0 }],
          },
        ],
      }),
    )
    mockEnvironment(null)
    const sockets = trackClients(pairedPhone)
    const { router } = renderWebApp(pairPath(), { createEnvironmentClient: sockets.create })

    await user.click(await screen.findByRole('button', { name: 'Update access' }))
    // Connecting remounts the page; the redeem still goes out once.
    await waitFor(() => expect(router.state.location.pathname).toBe('/'))
    const redeemed = sockets.clients.flatMap((client) =>
      client.calls.filter((call) => call.command === 'redeemPairingLink'),
    )
    expect(redeemed).toHaveLength(1)
  })

  it('says so when the owner opens a link, and keeps its credential', async () => {
    const user = userEvent.setup()
    const saved = `omc1.${'s'.repeat(43)}`
    localStorage.setItem(
      ENVIRONMENT_STORAGE_KEY,
      JSON.stringify({
        version: 2,
        selectedId: 'env-desk',
        environments: [
          {
            environmentId: 'env-desk',
            label: 'Desk',
            credential: saved,
            routes: [{ type: 'remote', endpoint: LAN, priority: 0 }],
          },
        ],
      }),
    )
    mockEnvironment(null)
    const sockets = trackClients((environmentId) =>
      createMockEnvironmentClient({
        seed: {
          environment: { environmentId, name: 'Desk' },
          pairingLinks: [{ link: LINK, token: TOKEN }],
        },
      }),
    )
    const { router } = renderWebApp(pairPath(), { createEnvironmentClient: sockets.create })
    await connectedShell()
    await user.click(screen.getByRole('button', { name: 'Update access' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/already has full access/)
    expect(router.state.location.pathname).toBe('/pair')
    expect(stored().environments[0]!.credential).toBe(saved)
  })

  it('explains a link it cannot read', async () => {
    mockEnvironment(null)
    renderWebApp('/pair#v=1&route=https%3A%2F%2Fdesk.example&environment=env-desk')
    expect(
      await screen.findByRole('heading', { name: 'This pairing link does not work' }),
    ).toBeVisible()
    expect(screen.getByText(/Part of it is missing/)).toBeVisible()
  })
})
