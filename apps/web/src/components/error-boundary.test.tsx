import { cleanup, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderWithinBoundary } from '../test-utils'

afterEach(() => {
  cleanup()
})

function Boom(): never {
  throw new Error('session renderer crashed')
}

describe('ErrorBoundary', () => {
  it('renders a recovery surface when a child throws', async () => {
    const user = userEvent.setup()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    renderWithinBoundary(<Boom />)

    expect(screen.getByRole('heading', { name: 'Something went wrong' })).toBeInTheDocument()
    expect(screen.getByText('session renderer crashed')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(screen.getByRole('heading', { name: 'Something went wrong' })).toBeInTheDocument()

    spy.mockRestore()
  })
})
