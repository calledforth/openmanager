import { cleanup, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { useTheme } from './theme-provider'
import { renderWithTheme } from '../test-utils'

afterEach(() => {
  cleanup()
  localStorage.clear()
  delete document.documentElement.dataset.theme
  delete document.documentElement.dataset.uiFont
})

function ThemeProbe() {
  const { theme, setTheme } = useTheme()
  return (
    <div>
      <span data-testid="theme-value">{theme}</span>
      <button type="button" onClick={() => setTheme('light')}>
        Light
      </button>
      <button type="button" onClick={() => setTheme('black')}>
        Black
      </button>
    </div>
  )
}

describe('ThemeProvider', () => {
  it('defaults to dark and applies light and black tokens', async () => {
    const user = userEvent.setup()
    renderWithTheme(<ThemeProbe />)

    expect(screen.getByTestId('theme-value').textContent).toBe('dark')
    expect(document.documentElement.dataset.theme).toBeUndefined()

    await user.click(screen.getByRole('button', { name: 'Light' }))
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(localStorage.getItem('openmanager-theme')).toBe('light')

    await user.click(screen.getByRole('button', { name: 'Black' }))
    expect(document.documentElement.dataset.theme).toBe('black')
  })
})
