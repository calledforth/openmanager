// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { CommandPalette } from '../src/components/command/CommandPalette'
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
})

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

const rowLabels = () =>
  [...document.querySelectorAll('[role="option"]')].map(
    (el) => el.querySelector('.truncate')?.textContent,
  )

function openPalette() {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() =>
    root!.render(
      <ThemeProvider>
        <CommandPalette />
      </ThemeProvider>,
    ),
  )
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))
  })
  const input = document.querySelector<HTMLInputElement>('input[role="combobox"]')
  expect(input).toBeTruthy()
  return input!
}

describe('CommandPalette', () => {
  it('opens on Ctrl+K with the field focused', () => {
    const input = openPalette()
    expect(document.activeElement).toBe(input)
  })

  it('narrows the rows as the query grows', () => {
    const input = openPalette()
    const all = rowLabels().length
    act(() => type(input, 'c'))
    expect(rowLabels().length).toBeLessThan(all)
    act(() => type(input, 'carb'))
    expect(rowLabels()).toEqual(['Carbon'])
  })

  it('matches a theme by its hint, not by a blanket keyword', () => {
    const input = openPalette()
    act(() => type(input, 'light'))
    expect(rowLabels()).toEqual(['Light', 'Neutral Light', 'Neutral Light Soft', 'Lovable Light'])
  })

  it('still finds a whole group by its keyword', () => {
    const input = openPalette()
    act(() => type(input, 'font'))
    expect(rowLabels()).toEqual(['Geist', 'Inter', 'Public Sans', 'System UI'])
  })
})
