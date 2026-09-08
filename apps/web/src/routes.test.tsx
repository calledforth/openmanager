import { cleanup, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ENVIRONMENT_STORAGE_KEY } from './lib/environment-store'
import { CONNECTION_STORIES } from './stories/connection-states'
import { renderWebApp } from './test-utils'

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.unstubAllGlobals()
})

describe('web routes', () => {
  it('renders the no-environment screen on first run', async () => {
    renderWebApp('/')
    expect(await screen.findByRole('heading', { name: 'No environment configured' })).toBeInTheDocument()
    expect(screen.getByLabelText('Environment endpoint')).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument()
  })

  it('keeps settings reachable without an environment', async () => {
    const user = userEvent.setup()
    renderWebApp('/settings')

    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeInTheDocument()
    await user.click(screen.getByRole('radio', { name: 'Light' }))
    expect(screen.getByRole('radio', { name: 'Light' })).toBeChecked()
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(localStorage.getItem('openmanager-theme')).toBe('light')

    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('radio', { name: 'Dark' })).toBeChecked()
    expect(document.documentElement.dataset.theme).toBeUndefined()
  })

  it('shows the connection story playground for every state', async () => {
    renderWebApp('/playground/connection')
    expect(await screen.findByRole('heading', { name: 'Connection states' })).toBeInTheDocument()
    for (const story of CONNECTION_STORIES) {
      expect(screen.getByRole('heading', { name: story.name })).toBeInTheDocument()
    }
  })

  it('connects from the first-run screen using the bootstrap response', async () => {
    const user = userEvent.setup()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          protocolVersion: 1,
          environmentId: 'env-local',
          capabilities: ['connection.heartbeat'],
          label: 'Local environment',
        }),
      })),
    )

    renderWebApp('/')
    await user.type(await screen.findByLabelText('Environment endpoint'), 'http://127.0.0.1:43120')
    await user.click(screen.getByRole('button', { name: 'Connect' }))

    expect(await screen.findByRole('heading', { name: 'Start a session' })).toBeInTheDocument()
    expect(screen.getByText(/Connected · Local environment/)).toBeInTheDocument()
    expect(JSON.parse(localStorage.getItem(ENVIRONMENT_STORAGE_KEY) ?? '{}')).toMatchObject({
      endpoint: 'http://127.0.0.1:43120',
      environmentId: 'env-local',
      label: 'Local environment',
    })
  })

  it('opens a session workspace after a stored environment is ready', async () => {
    localStorage.setItem(
      ENVIRONMENT_STORAGE_KEY,
      JSON.stringify({
        endpoint: 'http://127.0.0.1:43120',
        environmentId: 'env-local',
        label: 'Local environment',
      }),
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          protocolVersion: 1,
          environmentId: 'env-local',
          capabilities: [],
          label: 'Local environment',
        }),
      })),
    )

    const user = userEvent.setup()
    renderWebApp('/')

    await user.click(await screen.findByRole('link', { name: 'Open example session' }))
    expect(await screen.findByRole('heading', { name: 'Session' })).toBeInTheDocument()
    expect(screen.getByText('example')).toBeInTheDocument()
  })

  it('shows an in-shell unreachable banner instead of replacing the session', async () => {
    localStorage.setItem(
      ENVIRONMENT_STORAGE_KEY,
      JSON.stringify({ endpoint: 'http://127.0.0.1:43120', environmentId: 'env-local' }),
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down')
      }),
    )

    renderWebApp('/')
    expect(await screen.findByRole('alert')).toHaveTextContent('Environment unreachable')
    expect(screen.getByRole('heading', { name: 'Start a session' })).toBeInTheDocument()
  })

  it('shows the not-found surface for unknown paths once connected', async () => {
    localStorage.setItem(
      ENVIRONMENT_STORAGE_KEY,
      JSON.stringify({
        endpoint: 'http://127.0.0.1:43120',
        environmentId: 'env-local',
      }),
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          protocolVersion: 1,
          environmentId: 'env-local',
          capabilities: [],
        }),
      })),
    )

    renderWebApp('/missing')
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument()
  })
})
