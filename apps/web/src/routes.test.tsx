import { cleanup, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { renderWebApp } from './test-utils'

afterEach(() => {
  cleanup()
  localStorage.clear()
})

describe('web routes', () => {
  it('renders the session landing at /', async () => {
    renderWebApp('/')
    expect(await screen.findByRole('heading', { name: 'Start a session' })).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument()
  })

  it('opens a session workspace from the landing', async () => {
    const user = userEvent.setup()
    renderWebApp('/')

    await user.click(await screen.findByRole('link', { name: 'Open example session' }))
    expect(await screen.findByRole('heading', { name: 'Session' })).toBeInTheDocument()
    expect(screen.getByText('example')).toBeInTheDocument()
  })

  it('renders settings and persists the selected theme', async () => {
    const user = userEvent.setup()
    renderWebApp('/settings')

    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeInTheDocument()
    await user.click(screen.getByRole('radio', { name: 'Light' }))
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(localStorage.getItem('openmanager-theme')).toBe('light')
  })

  it('shows the not-found surface for unknown paths', async () => {
    renderWebApp('/missing')
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument()
  })
})
