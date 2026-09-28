// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { NewSessionLandingView } from '../src/components/chat/NewSessionLanding'
import type { WorkspaceEntry } from '../src/providers/sidebar-provider'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
})) as unknown as typeof window.matchMedia

const WORKSPACES: WorkspaceEntry[] = [
  { path: '/repos/openmanager', name: 'openmanager' },
  { path: '/repos/agentpack', name: 'agentpack' },
  { path: '/repos/notes', name: 'notes' },
]

let root: Root | null = null
let host: HTMLElement | null = null
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
})

function render() {
  const onSelectWorkspace = vi.fn()
  const onAddWorkspace = vi.fn()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() =>
    root!.render(
      <NewSessionLandingView
        environmentLabel="devbox"
        workspaces={WORKSPACES}
        recentWorkspaces={[WORKSPACES[1]!]}
        activeWorkspacePath="/repos/openmanager"
        isWorkspacesLoading={false}
        isStarting={false}
        onSelectWorkspace={onSelectWorkspace}
        onAddWorkspace={onAddWorkspace}
      />,
    ),
  )
  return { onSelectWorkspace, onAddWorkspace }
}

function press(key: string, init: KeyboardEventInit = {}) {
  const target = document.activeElement ?? window
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }))
  })
}

function open() {
  press('P', { ctrlKey: true, shiftKey: true, code: 'KeyP' })
  const input = document.querySelector<HTMLInputElement>('input[role="combobox"]')
  expect(input).toBeTruthy()
  return input!
}

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const labels = () =>
  [...document.querySelectorAll('[role="option"]')].map(
    (row) => row.querySelector('.truncate')?.textContent,
  )
const highlighted = () =>
  document.querySelector('[role="option"][aria-selected="true"] .truncate')?.textContent

describe('ProjectPicker', () => {
  it('opens on Ctrl+Shift+P on the active project, recents first, add last', () => {
    render()
    const input = open()
    expect(document.activeElement).toBe(input)
    expect(labels()).toEqual(['agentpack', 'openmanager', 'notes', 'Add project…'])
    expect(highlighted()).toBe('openmanager')
    // The footer names the environment and nothing else: no key hints.
    expect(document.body.textContent).toContain('devbox')
    expect(document.querySelector('[data-slot="command-menu-footer"]')).toBeNull()
  })

  it('opens the picked project', () => {
    const { onSelectWorkspace } = render()
    open()
    press('ArrowDown')
    press('Enter')
    expect(onSelectWorkspace).toHaveBeenCalledWith('/repos/notes')
    expect(document.querySelector('input[role="combobox"]')).toBeNull()
  })

  it('does not reopen the project that is already open', () => {
    const { onSelectWorkspace } = render()
    open()
    press('Enter')
    expect(onSelectWorkspace).not.toHaveBeenCalled()
  })

  it('keeps "Add project" reachable whatever is typed', () => {
    const { onAddWorkspace } = render()
    const input = open()
    type(input, 'zzz')
    expect(labels()).toEqual(['Add project…'])
    press('Enter')
    expect(onAddWorkspace).toHaveBeenCalledTimes(1)
  })

  it('closes on Escape', () => {
    render()
    const input = open()
    type(input, 'no')
    press('Escape')
    expect(document.querySelector('input[role="combobox"]')).toBeNull()
  })
})
