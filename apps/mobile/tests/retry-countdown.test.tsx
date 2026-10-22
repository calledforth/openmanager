// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RetryCountdown } from '../src/environment/RetryCountdown'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
beforeEach(() => {
  vi.useFakeTimers({ now: 1_000_000 })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

/** A stand-in for the panel: counts its own renders and the countdown line's. */
function mount(retryAt: number | null) {
  const renders = { panel: 0, line: 0 }
  let setRetryAt!: (next: number | null) => void
  function Panel() {
    const [at, set] = useState(retryAt)
    setRetryAt = set
    renders.panel += 1
    return (
      <div>
        <h1>Can&apos;t reach Studio</h1>
        <RetryCountdown retryAt={at}>
          {(words) => {
            renders.line += 1
            return <p data-testid="line">{words ?? 'Trying to reconnect…'}</p>
          }}
        </RetryCountdown>
        <button type="button">Try again now</button>
      </div>
    )
  }
  act(() => root.render(<Panel />))
  const line = () => host.querySelector('[data-testid="line"]')!.textContent
  return { renders, line, setRetryAt: (next: number | null) => act(() => setRetryAt(next)) }
}

describe('the retry countdown', () => {
  it('ticks once a second rendering only its own line, never the panel around it', () => {
    const view = mount(Date.now() + 4000)
    expect(view.line()).toBe('Trying again in 4 s')
    const { panel, line } = view.renders
    for (const left of [3, 2, 1]) {
      act(() => vi.advanceTimersByTime(1000))
      expect(view.line()).toBe(`Trying again in ${left} s`)
    }
    expect(view.renders.panel).toBe(panel)
    expect(view.renders.line).toBe(line + 3)
  })

  it('stops ticking when nothing is scheduled any more, and reads the words it was given', () => {
    const view = mount(Date.now() + 8000)
    expect(vi.getTimerCount()).toBe(1)
    view.setRetryAt(null)
    expect(vi.getTimerCount()).toBe(0)
    expect(view.line()).toBe('Trying to reconnect…')
    const renders = view.renders.line
    act(() => vi.advanceTimersByTime(5000))
    expect(view.renders.line).toBe(renders)
  })

  it('restarts with a new schedule and leaves no timer behind on unmount', () => {
    const view = mount(Date.now() + 2000)
    view.setRetryAt(Date.now() + 15_000)
    expect(vi.getTimerCount()).toBe(1)
    expect(view.line()).toBe('Trying again in 15 s')
    act(() => root.unmount())
    expect(vi.getTimerCount()).toBe(0)
    root = createRoot(host)
  })

  it('runs no timer at all with nothing scheduled', () => {
    mount(null)
    expect(vi.getTimerCount()).toBe(0)
  })
})
