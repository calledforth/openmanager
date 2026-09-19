// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MessageInputView, type ProviderModelGroup } from './MessageInputView'

const GROUPS: ProviderModelGroup[] = [
  {
    providerId: 'opencode',
    providerName: 'OpenCode',
    models: [{ id: 'gpt-5.1', name: 'GPT-5.1' }],
  },
]

function installMemoryStorage() {
  const store = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      get length() {
        return store.size
      },
      clear: () => store.clear(),
      getItem: (key: string) => store.get(key) ?? null,
      key: (index: number) => [...store.keys()][index] ?? null,
      removeItem: (key: string) => {
        store.delete(key)
      },
      setItem: (key: string, value: string) => {
        store.set(key, value)
      },
    },
  })
}

function defaults(overrides: Partial<Parameters<typeof MessageInputView>[0]> = {}) {
  return {
    disabled: false,
    pendingDraftSessionStart: false,
    activeWorkspacePath: '/repo',
    activeSessionId: 'sess-1',
    isSessionDraftOpen: false,
    providerReady: true,
    currentProviderId: 'opencode' as const,
    providerModelGroups: GROUPS,
    currentModelId: 'gpt-5.1',
    configOptions: [],
    modeOptions: [],
    currentModeId: '',
    effortLevels: [],
    currentEffort: '',
    canChangeSettings: true,
    canChangeProvider: false,
    showModeControl: false,
    showModelControl: false,
    isStreaming: false,
    draftKey: 'session:sess-1',
    imageUploadEnabled: false,
    imageSupportMessage: 'Image prompts are not available on this host.',
    onModeChange: () => undefined,
    onProviderModelChange: () => undefined,
    onConfigOptionChange: () => undefined,
    onSend: async () => undefined,
    onAbort: () => undefined,
    ...overrides,
  }
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  installMemoryStorage()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
  }))
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const render = (props: Partial<Parameters<typeof MessageInputView>[0]> = {}) =>
  act(() => root.render(<MessageInputView {...defaults(props)} />))

describe('MessageInputView', () => {
  it('does not advertise slash workflows when the provider has published none', async () => {
    await render()
    const textarea = container.querySelector('textarea')
    expect(textarea?.placeholder).toBe('Ask anything')
    expect(textarea?.placeholder).not.toContain('/ for workflows')
  })

  it('mentions slash workflows only once commands exist', async () => {
    await render({
      slashCommands: [{ name: 'simplify', description: 'Shorten the last reply' }],
    })
    expect(container.querySelector('textarea')?.placeholder).toBe(
      'Ask anything, @ to mention, / for workflows',
    )
  })

  it('stops a running turn on Escape', async () => {
    const onAbort = vi.fn()
    await render({ isStreaming: true, onAbort })
    await act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(onAbort).toHaveBeenCalledTimes(1)
  })

  it('does not treat Escape as stop when nothing is running', async () => {
    const onAbort = vi.fn()
    await render({ isStreaming: false, onAbort })
    await act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(onAbort).not.toHaveBeenCalled()
  })

  it('lets Escape dismiss the slash popup instead of interrupting', async () => {
    const onAbort = vi.fn()
    await render({
      isStreaming: true,
      onAbort,
      slashCommands: [{ name: 'simplify', description: 'Shorten the last reply' }],
    })
    const textarea = container.querySelector('textarea')!
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    await act(() => {
      setter.call(textarea, '/')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(document.querySelector('[role="listbox"][aria-label="Slash commands"]')).not.toBeNull()
    await act(() => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(onAbort).not.toHaveBeenCalled()
    expect(document.querySelector('[role="listbox"][aria-label="Slash commands"]')).toBeNull()
  })
})
