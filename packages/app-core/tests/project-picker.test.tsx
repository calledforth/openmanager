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

const SCRATCH: WorkspaceEntry = { path: 'scratch-id', name: 'No project', scratch: true }

function render(workspaces = WORKSPACES, recentWorkspaces = [WORKSPACES[1]!]) {
  const onSelectWorkspace = vi.fn()
  const onAddWorkspace = vi.fn()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() =>
    root!.render(
      <NewSessionLandingView
        environmentLabel="devbox"
        workspaces={workspaces}
        recentWorkspaces={recentWorkspaces}
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

  it('pins "No project" first, apart from recents and the rest', () => {
    const { onSelectWorkspace } = render([SCRATCH, ...WORKSPACES], [SCRATCH, WORKSPACES[1]!])
    open()
    expect(labels()).toEqual(['No project', 'agentpack', 'openmanager', 'notes', 'Add project…'])
    const row = document.querySelector('[role="option"]')!
    expect(row.querySelector('svg path')?.getAttribute('d')).toMatch(/^M82,209/)
    act(() => (row as HTMLElement).click())
    expect(onSelectWorkspace).toHaveBeenCalledWith('scratch-id')
  })

  it('closes on Escape', () => {
    render()
    const input = open()
    type(input, 'no')
    press('Escape')
    expect(document.querySelector('input[role="combobox"]')).toBeNull()
  })
})
