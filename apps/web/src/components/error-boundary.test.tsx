import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ErrorFallback, reloadWebApp } from './error-boundary'
import { renderWithinBoundary } from '../test-utils'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function Boom(): never {
  throw new Error('session renderer crashed')
}

describe('ErrorBoundary', () => {
  it('renders a recovery surface that does not retry the same child', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    renderWithinBoundary(<Boom />)

    expect(screen.getByRole('heading', { name: 'Something went wrong' })).toBeInTheDocument()
    expect(screen.getByText('session renderer crashed')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument()
  })

  it('Reload navigates to the session landing instead of remounting the failure', async () => {
    const user = userEvent.setup()
    const onReload = vi.fn()
    render(<ErrorFallback error={new Error('session renderer crashed')} onReload={onReload} />)

    await user.click(screen.getByRole('button', { name: 'Reload' }))
    expect(onReload).toHaveBeenCalledTimes(1)
  })

  it('reloadWebApp assigns the known-safe route', () => {
    const target = { assign: vi.fn() }
    reloadWebApp(target)
    expect(target.assign).toHaveBeenCalledWith('/')
  })
})
