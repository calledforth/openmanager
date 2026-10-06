// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { CommandPalette } from '../src/components/command/CommandPalette'
import { ProviderModelPicker } from '../src/components/chat/ProviderModelPicker'
import { ThemeProvider } from '../src/providers/theme-provider'

window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
})) as unknown as typeof window.matchMedia
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let host: HTMLElement | null = null
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
})

function render(withPicker: boolean) {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() =>
    root!.render(
      <ThemeProvider>
        <textarea aria-label="Composer" />
        {withPicker && (
          <ProviderModelPicker
            groups={[
              {
                providerId: 'claude',
                providerName: 'Claude Code',
                models: [
                  { id: 'opus', name: 'Opus' },
                  { id: 'sonnet', name: 'Sonnet' },
                ],
              },
            ]}
            currentProviderId="claude"
            currentModelId="opus"
            onChange={() => undefined}
            canChangeProvider
          />
        )}
        <CommandPalette />
      </ThemeProvider>,
    ),
  )
  document.querySelector<HTMLTextAreaElement>('textarea')!.focus()
}

function openPalette() {
  act(() => {
    document.activeElement!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }),
    )
  })
  return document.querySelector<HTMLInputElement>('input[role="combobox"]')!
}

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const rowLabels = () =>
  [...document.querySelectorAll('[role="option"]')].map(
    (el) => el.querySelector('.truncate')?.textContent,
  )

describe('palette → pickers', () => {
  it('offers "Switch model…" only while a model picker is on screen', () => {
    render(false)
    type(openPalette(), 'switch')
    expect(rowLabels()).not.toContain('Switch model…')
    act(() => root?.unmount())
    host?.remove()

    render(true)
    type(openPalette(), 'switch')
    expect(rowLabels()).toContain('Switch model…')
    expect(rowLabels()).not.toContain('Switch project…')
  })

  it('opens the model picker and keeps the keys there once the palette has closed', async () => {
    render(true)
    const input = openPalette()
    type(input, 'switch model')
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    // Let the palette's exit run and hand focus back to where it came from.
    await act(() => new Promise((resolve) => setTimeout(resolve, 600)))
    const picker = document.querySelector('[role="dialog"][aria-label="Select model"]')
    expect(picker).toBeTruthy()
    expect(picker!.contains(document.activeElement)).toBe(true)
    expect(document.activeElement?.getAttribute('placeholder')).toBe('Search models…')
  })
})
