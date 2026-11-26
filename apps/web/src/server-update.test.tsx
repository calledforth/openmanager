import { PROTOCOL_VERSION, type ServerUpdateStatus } from '@openmanager/protocol'
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ENVIRONMENT_STORAGE_KEY } from '@openmanager/environment-client/connection'
import { renderWebApp } from './test-utils'

const DESK = 'http://127.0.0.1:43120'

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function seed() {
  localStorage.setItem(
    ENVIRONMENT_STORAGE_KEY,
    JSON.stringify({
      version: 1,
      selectedId: 'env-desk',
      environments: [
        { environmentId: 'env-desk', label: 'Desk', endpoints: [DESK], credential: 'desk-token' },
      ],
    }),
  )
}

const available: ServerUpdateStatus = {
  currentVersion: '0.21.0',
  latestVersion: '0.22.0',
  updateAvailable: true,
  checkedAt: '2026-11-26T00:00:00.000Z',
  canUpdate: true,
  state: 'idle',
}

/** Bootstrap answers as Desk; /server-update answers from `update`. */
function serve(update: { status: ServerUpdateStatus; posts: RequestInit[] }) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/server-update')) {
        if (init?.method === 'POST') {
          update.posts.push(init)
          update.status = { ...update.status, state: 'updating', targetVersion: '0.22.0' }
          return Response.json(update.status, { status: 202 })
        }
        return Response.json(update.status)
      }
      return Response.json({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: ['connection.heartbeat'],
        environmentId: 'env-desk',
        label: 'Desk',
      })
    }),
  )
}

describe('server updates', () => {
  it('toasts a new server release and updates it from the toast', async () => {
    seed()
    const update = { status: available, posts: [] as RequestInit[] }
    serve(update)
    renderWebApp('/')
    const toast = await screen.findByText('Server update')
    const pill = toast.closest('[role="status"]') as HTMLElement
    expect(within(pill).getByText(/Desk 0\.21\.0 → 0\.22\.0/)).toBeTruthy()
    // The shell settles once the socket is up; take the button as it is now.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Update' }).isConnected).toBe(true),
    )
    await userEvent.click(screen.getByRole('button', { name: 'Update' }))
    await waitFor(() => expect(document.body.textContent).toContain('Updating Desk to 0.22.0'))
    expect(update.posts).toHaveLength(1)
    expect(new Headers(update.posts[0]!.headers).get('authorization')).toBe('Bearer desk-token')
    expect(JSON.parse(String(update.posts[0]!.body))).toEqual({ version: '0.22.0' })
  })

  it('remembers "Not now" for that version', async () => {
    seed()
    serve({ status: available, posts: [] })
    const first = renderWebApp('/')
    await screen.findByText('Server update')
    await userEvent.click(screen.getByRole('button', { name: 'Not now' }))
    expect(screen.queryByText('Server update')).toBeNull()
    first.unmount()
    renderWebApp('/')
    await screen.findAllByText(/Desk/)
    // Give the watcher its first read before saying nothing showed.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(screen.queryByText('Server update')).toBeNull()
  })

  it('shows the server version and its update under the environment in Settings', async () => {
    seed()
    serve({ status: available, posts: [] })
    renderWebApp('/settings?tab=environments')
    const line = await screen.findByLabelText('Server version')
    await waitFor(() => expect(within(line).getByText('Server 0.21.0')).toBeTruthy())
    expect(within(line).getByText('0.22.0 available')).toBeTruthy()
    expect(within(line).getByRole('button', { name: 'Update to 0.22.0' })).toBeTruthy()
  })

  it('says what to run when the server cannot update itself', async () => {
    seed()
    serve({
      status: {
        ...available,
        canUpdate: false,
        cannotUpdateReason: 'This server runs from a source checkout.',
      },
      posts: [],
    })
    renderWebApp('/')
    const toast = await screen.findByText('Server update')
    const pill = toast.closest('[role="status"]') as HTMLElement
    expect(within(pill).queryByRole('button', { name: 'Update' })).toBeNull()
    expect(within(pill).getByText(/openmanager update/)).toBeTruthy()
  })
})
