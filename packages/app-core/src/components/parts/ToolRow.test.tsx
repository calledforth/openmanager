// @vitest-environment jsdom
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EnvironmentClient } from '@openmanager/environment-client'
import { ToolRow, type ToolRowPart } from './ToolRow'

const client = vi.hoisted(() => ({ current: undefined as unknown }))
vi.mock('../../providers/environment-client', () => ({
  useEnvironmentClientOptional: () => client.current,
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let container: HTMLElement

function render(element: ReactElement) {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => root!.render(element))
  return { container }
}

afterEach(() => {
  act(() => root?.unmount())
  container.remove()
  client.current = undefined
})

const shown = () => container.textContent ?? ''

const settled: ToolRowPart = {
  type: 'tool',
  id: 'tool-1',
  callID: 'tool-1',
  sessionId: 'session-1',
  toolName: 'Grep',
  outputBytes: 12,
  state: { status: 'completed', input: { pattern: 'needle', path: 'src' } },
}

function open(from: HTMLElement) {
  const details = from.querySelector('details')!
  act(() => {
    details.open = true
    details.dispatchEvent(new Event('toggle'))
  })
}

describe('ToolRow', () => {
  it('says what happened before anything is fetched', () => {
    const fetchToolOutput = vi.fn()
    client.current = { fetchToolOutput } as Partial<EnvironmentClient>
    render(<ToolRow part={settled} />)
    expect(shown()).toContain('Searched for')
    expect(shown()).toContain('"needle" in src')
    expect(fetchToolOutput).not.toHaveBeenCalled()
  })

  it('fetches the output when opened, and shows it as it came', async () => {
    const fetchToolOutput = vi.fn().mockResolvedValue('src/a.ts:1:needle')
    client.current = { fetchToolOutput } as Partial<EnvironmentClient>
    const view = render(<ToolRow part={settled} />)
    open(view.container)
    await act(async () => {})
    expect(fetchToolOutput).toHaveBeenCalledWith(
      { sessionId: 'session-1', toolCallId: 'tool-1' },
      expect.anything(),
    )
    expect(shown()).toContain('src/a.ts:1:needle')
  })

  it('says when it could not, and tries again', async () => {
    const fetchToolOutput = vi
      .fn()
      .mockRejectedValueOnce(new Error('unavailable'))
      .mockResolvedValue('found it')
    client.current = { fetchToolOutput } as Partial<EnvironmentClient>
    const view = render(<ToolRow part={settled} />)
    open(view.container)
    await act(async () => {})
    await act(async () => {
      container.querySelector('button')!.click()
    })
    expect(shown()).toContain('found it')
  })

  it('shows running text without fetching', () => {
    const fetchToolOutput = vi.fn()
    client.current = { fetchToolOutput } as Partial<EnvironmentClient>
    const view = render(
      <ToolRow
        part={{
          ...settled,
          toolName: 'Bash',
          outputBytes: undefined,
          state: { status: 'running', input: { command: 'pnpm build' }, output: 'building' },
        }}
      />,
    )
    open(view.container)
    expect(shown()).toContain('building')
    expect(fetchToolOutput).not.toHaveBeenCalled()
  })

  it('has nothing to open on a read, which is its path alone', () => {
    const { container } = render(
      <ToolRow
        part={{
          type: 'tool',
          id: 'tool-2',
          toolName: 'Read',
          locations: [{ path: 'src/a.ts' }],
          state: { status: 'completed', input: { file_path: 'src/a.ts' } },
        }}
      />,
    )
    expect(container.querySelector('details')).toBeNull()
    expect(shown()).toContain('a.ts')
  })

  it('names a refusal, and keeps nothing mounted while closed', () => {
    const { container } = render(
      <ToolRow
        part={{
          ...settled,
          toolName: 'Bash',
          state: { status: 'declined', input: { command: 'rm' } },
        }}
      />,
    )
    expect(shown()).toContain('Declined')
    expect(container.querySelector('pre')).toBeNull()
  })
})
