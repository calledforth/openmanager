// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PENDING_REASON, sessionMenuItems } from '../src/session/session-menu'
import type { SessionActions } from '../src/session/useSessionActions'
import { FAILURE_MS, useSessionChrome, type SessionChrome } from '../src/session/useSessionChrome'

/** A promise the test settles when it wants, in whatever order. */
function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

const MENU = sessionMenuItems({
  mark: 'done',
  settled: false,
  backgroundTaskCount: 0,
  unavailable: null,
  supports: () => true,
})

let chrome: SessionChrome | null = null
function Probe({ actions, title }: { actions: SessionActions; title: string }) {
  chrome = useSessionChrome(actions, title)
  return null
}

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  chrome = null
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const flush = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))

function harness() {
  const runs: Array<{ id: string; done: ReturnType<typeof deferred> }> = []
  const renames: Array<{ title: string; done: ReturnType<typeof deferred> }> = []
  const actions: SessionActions = {
    menu: MENU,
    unavailable: null,
    run: (id) => {
      const done = deferred()
      runs.push({ id, done })
      return done.promise
    },
    rename: (title) => {
      const done = deferred()
      renames.push({ title, done })
      return done.promise
    },
  }
  return { actions, runs, renames }
}

describe('the session header chrome', () => {
  it('holds every other command, and the title, while one is out', async () => {
    const { actions, runs, renames } = harness()
    await act(() => root.render(<Probe actions={actions} title="First" />))

    act(() => chrome!.choose('regenerate-title'))
    expect(chrome!.note).toEqual({ kind: 'busy', text: 'Naming the session…' })
    expect(chrome!.pending).toBe(true)
    // The other items wait, listed with why; the title is not editable.
    expect(chrome!.menu.every((item) => item.disabledReason !== null)).toBe(true)
    expect(chrome!.menu.find((item) => item.id === 'settle')?.disabledReason).toBe(PENDING_REASON)
    expect(chrome!.canRename).toBe(false)

    // A second command, or a rename, while the first is out goes nowhere.
    act(() => chrome!.choose('settle'))
    act(() => chrome!.startEditing())
    act(() => chrome!.commitTitle('Second'))
    expect(runs.map((run) => run.id)).toEqual(['regenerate-title'])
    expect(renames).toHaveLength(0)
    expect(chrome!.editing).toBe(false)

    await act(async () => runs[0]!.done.resolve())
    await flush()
    expect(chrome!.note).toBeNull()
    expect(chrome!.pending).toBe(false)
    expect(chrome!.canRename).toBe(true)
  })

  it('keeps a failure until the reader acts again, then the newer command owns the line', async () => {
    const { actions, runs, renames } = harness()
    await act(() => root.render(<Probe actions={actions} title="First" />))

    act(() => chrome!.choose('regenerate-title'))
    await act(async () => runs[0]!.done.reject(new Error('titles are off')))
    await flush()
    expect(chrome!.note).toEqual({ kind: 'failed', text: 'Could not name it: titles are off' })
    expect(chrome!.pending).toBe(false)

    // Renaming next replaces the failure; its own answer is the one shown.
    act(() => chrome!.startEditing())
    act(() => chrome!.commitTitle('  Second  '))
    expect(renames.map((rename) => rename.title)).toEqual(['Second'])
    expect(chrome!.note).toEqual({ kind: 'busy', text: 'Renaming…' })
    await act(async () => renames[0]!.done.reject(new Error('refused')))
    await flush()
    expect(chrome!.note).toEqual({ kind: 'failed', text: 'Could not rename: refused' })
  })

  it('lets a failure go after a while', async () => {
    vi.useFakeTimers()
    try {
      const { actions, runs } = harness()
      await act(() => root.render(<Probe actions={actions} title="First" />))
      act(() => chrome!.choose('settle'))
      await act(async () => runs[0]!.done.reject(new Error('live work')))
      expect(chrome!.note?.kind).toBe('failed')
      await act(async () => vi.advanceTimersByTime(FAILURE_MS))
      expect(chrome!.note).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('sends no rename for an unchanged or empty title', async () => {
    const { actions, renames } = harness()
    await act(() => root.render(<Probe actions={actions} title="First" />))
    act(() => chrome!.startEditing())
    act(() => chrome!.commitTitle(' First '))
    act(() => chrome!.startEditing())
    act(() => chrome!.commitTitle('   '))
    expect(renames).toHaveLength(0)
    expect(chrome!.note).toBeNull()
    expect(chrome!.editing).toBe(false)
  })

  it('writes nothing once the page has gone', async () => {
    const { actions, runs } = harness()
    await act(() => root.render(<Probe actions={actions} title="First" />))
    act(() => chrome!.choose('settle'))
    const last = chrome
    await act(() => root.unmount())
    root = createRoot(container)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await act(async () => runs[0]!.done.resolve())
    await flush()
    expect(error).not.toHaveBeenCalled()
    expect(last!.note).toEqual({ kind: 'busy', text: 'Settling…' })
    error.mockRestore()
  })
})
