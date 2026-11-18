// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  createMockEnvironmentClient,
  type MockEnvironmentClient,
} from '@openmanager/environment-client'
import { SCRATCHPAD_MAX_BYTES, type Workspace } from '@openmanager/protocol'
import { EnvironmentClientProvider } from '../src/providers/environment-client'
import { matchLines, mergeLines } from '../src/lib/scratchpad/merge'
import {
  createScratchpadController,
  scratchpadSeenKey,
  scratchpadUnsavedKey,
  useScratchpad,
  type ScratchpadSeenStore,
  type ScratchpadView,
} from '../src/lib/scratchpad/use-scratchpad'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const WORKSPACE: Workspace = {
  workspaceId: 'workspace-1',
  name: 'project',
  path: '/project',
  lastUsedAt: null,
  lastActivityAt: null,
  exists: true,
  capabilities: { git: false },
}

const SCRATCH: Workspace = {
  ...WORKSPACE,
  workspaceId: 'scratch',
  name: 'No project',
  kind: 'scratch',
}

/** A seen store of its own per test: nothing leaks between them. */
function memoryStore(): ScratchpadSeenStore & { values: Map<string, string> } {
  const values = new Map<string, string>()
  return {
    values,
    get: (key) => values.get(key) ?? null,
    set: (key, value) => void values.set(key, value),
  }
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

function setup(options: { content?: string; seen?: ScratchpadSeenStore } = {}) {
  const client = createMockEnvironmentClient({ seed: { workspaces: [WORKSPACE, SCRATCH] } })
  if (options.content !== undefined) client.editScratchpad('workspace-1', options.content)
  const seen = options.seen ?? memoryStore()
  const controller = createScratchpadController({
    client,
    workspaceId: 'workspace-1',
    environmentId: 'env-1',
    seen,
    saveDelayMs: 0,
    providerName: (id) => (id === 'claude' ? 'Claude' : id),
  })
  const stop = client.onScratchpadChanged!((next) => controller.receive(next))
  const settle = async () => {
    for (let i = 0; i < 5; i += 1) {
      await client.settle()
      await tick()
    }
  }
  return { client, controller, seen, stop, settle, view: () => controller.getSnapshot() }
}

describe('merging two edits of the scratchpad', () => {
  const base = '# Plan\n- one\n- two\n- three\n'

  it('keeps changes each side made to different lines', () => {
    const mine = '# Plan\n- one!\n- two\n- three\n'
    const theirs = '# Plan\n- one\n- two\n- three\n- four\n'
    expect(mergeLines(base, mine, theirs)).toBe('# Plan\n- one!\n- two\n- three\n- four\n')
  })

  it('lets mine win the lines both changed', () => {
    const mine = '# Plan\n- one\n- TWO (mine)\n- three\n'
    const theirs = '# Plan\n- one\n- 2 (theirs)\n- three\n'
    expect(mergeLines(base, mine, theirs)).toBe(mine)
  })

  it('keeps both sides of lines added at the same place, mine first', () => {
    const mine = `${base}- mine\n`
    const theirs = `${base}- theirs\n`
    expect(mergeLines(base, mine, theirs)).toBe(`${base}- mine\n- theirs\n`)
  })

  it('applies the same change once', () => {
    const both = `${base}- same\n`
    expect(mergeLines(base, both, both)).toBe(both)
    expect(mergeLines(base, `- top\n${base}`, `${base}- same\n`)).toBe(`- top\n${base}- same\n`)
  })

  it('keeps an outside change to a line the user did not touch, beside one both made', () => {
    expect(mergeLines('a\nb\nc', 'a\nB\nc', 'A\nB\nc')).toBe('A\nB\nc')
    expect(mergeLines('a\nb\nc', 'a\nB\nc', 'A\nX\nc')).toBe('A\nB\nc')
  })

  it('keeps both ends of a long scratchpad when each side changed one', () => {
    const lines = Array.from({ length: 5_000 }, (_, index) => `line ${index}`)
    const base = lines.join('\n')
    const mine = ['FIRST', ...lines.slice(1)].join('\n')
    const theirs = [...lines.slice(0, -1), 'LAST'].join('\n')
    expect(mergeLines(base, mine, theirs)).toBe(['FIRST', ...lines.slice(1, -1), 'LAST'].join('\n'))
  })

  it('finds a longest common run of lines, whatever the inputs', () => {
    // Checked against the quadratic table on small random inputs.
    let seed = 7
    const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31
    const lcs = (a: number[], b: number[]) => {
      const table = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0))
      for (let i = a.length - 1; i >= 0; i--)
        for (let j = b.length - 1; j >= 0; j--)
          table[i]![j] =
            a[i] === b[j]
              ? table[i + 1]![j + 1]! + 1
              : Math.max(table[i + 1]![j]!, table[i]![j + 1]!)
      return table[0]![0]!
    }
    for (let round = 0; round < 300; round++) {
      const a = Array.from({ length: Math.floor(random() * 30) }, () => Math.floor(random() * 5))
      const b = Array.from({ length: Math.floor(random() * 30) }, () => Math.floor(random() * 5))
      const pairs = matchLines(a, b)
      expect(pairs).toHaveLength(lcs(a, b))
      pairs.forEach(([i, j], index) => {
        expect(a[i]).toBe(b[j])
        if (index > 0) {
          expect(i).toBeGreaterThan(pairs[index - 1]![0])
          expect(j).toBeGreaterThan(pairs[index - 1]![1])
        }
      })
    }
  })

  it('starts from nothing', () => {
    expect(mergeLines('', 'mine', 'theirs')).toBe('mine\ntheirs')
    expect(mergeLines('', '', 'theirs')).toBe('theirs')
  })
})

describe('the scratchpad on one client', () => {
  it('reads the file and starts with nothing unseen', async () => {
    const { controller, view } = setup({ content: '# Plan\n' })
    expect(view().loading).toBe(true)
    await controller.load()
    expect(view()).toMatchObject({
      loading: false,
      content: '# Plan\n',
      unseen: null,
      lastEdit: { by: { kind: 'external' } },
      shareWithAgents: true,
    })
  })

  it('shows its own edits at once and saves them after the pause', async () => {
    const { client, controller, view, settle, seen } = setup()
    await controller.load()
    controller.edit('# Mine\n')
    expect(view()).toMatchObject({ content: '# Mine\n', saveState: 'saving' })
    await settle()
    expect(view()).toMatchObject({ content: '# Mine\n', saveState: 'saved', unseen: null })
    expect(client.calls.filter((call) => call.command === 'saveScratchpad')).toHaveLength(1)
    // What you wrote is what you have seen.
    expect(seen.get(scratchpadSeenKey('env-1', 'workspace-1'))).toBe('# Mine\n')
  })

  it("marks someone else's change unseen until it is marked read", async () => {
    const { client, controller, view } = setup({ content: 'one\n' })
    await controller.load()
    client.editScratchpad('workspace-1', 'one\ntwo\n', {
      kind: 'agent',
      sessionId: 'session-1',
      providerId: 'claude',
    })
    expect(view()).toMatchObject({
      content: 'one\ntwo\n',
      unseen: { by: { kind: 'agent', name: 'Claude' }, before: 'one\n' },
    })
    controller.markSeen()
    expect(view().unseen).toBeNull()
  })

  it('remembers what was seen across a reload of the page', async () => {
    const seen = memoryStore()
    const first = setup({ content: 'one\n', seen })
    await first.controller.load()
    first.client.editScratchpad('workspace-1', 'one\ntwo\n')
    // A new page over the same environment state and the same device storage.
    const again = createScratchpadController({
      client: first.client,
      workspaceId: 'workspace-1',
      environmentId: 'env-1',
      seen,
    })
    await again.load()
    expect(again.getSnapshot().unseen).toMatchObject({
      by: { kind: 'external' },
      before: 'one\n',
    })
  })

  it('never changes the text under the user while they type, and merges on save', async () => {
    const { client, controller, view, settle } = setup({ content: 'a\nb\nc\n' })
    await controller.load()
    controller.edit('A\nb\nc\n')
    // An agent appends while the edit waits to be saved.
    client.editScratchpad('workspace-1', 'a\nb\nc\nd\n', {
      kind: 'agent',
      sessionId: 'session-1',
      providerId: 'claude',
    })
    expect(view().content).toBe('A\nb\nc\n')
    expect(view().unseen).toBeNull()
    await settle()
    // The save was refused (the file moved), merged, and saved again.
    const saves = client.calls.filter((call) => call.command === 'saveScratchpad')
    expect(saves).toHaveLength(2)
    expect(view()).toMatchObject({ content: 'A\nb\nc\nd\n', saveState: 'saved' })
    expect((await client.commands.getScratchpad('workspace-1')).content).toBe('A\nb\nc\nd\n')
  })

  it('keeps the text and says so when a save fails', async () => {
    const { client, controller, view, settle } = setup()
    await controller.load()
    const original = client.commands.saveScratchpad
    client.commands.saveScratchpad = () => Promise.reject(new Error('offline'))
    controller.edit('unsaved\n')
    await settle()
    expect(view()).toMatchObject({ content: 'unsaved\n', saveState: 'error' })
    client.commands.saveScratchpad = original
    // The next connection's read sends it.
    await controller.load()
    await settle()
    expect(view()).toMatchObject({ content: 'unsaved\n', saveState: 'saved' })
  })

  it('keeps saving after the panel closes, newer typing and merges included', async () => {
    const { client, controller, settle, seen } = setup({ content: 'a\nb\n' })
    await controller.load()
    controller.edit('a\nb\none\n')
    // The first save is out (latency zero still waits a turn) when more is typed...
    controller.flush()
    controller.edit('a\nb\none\ntwo\n')
    // ...an agent writes the top line meanwhile, and the user opens another session.
    client.editScratchpad('workspace-1', 'A\nb\n', {
      kind: 'agent',
      sessionId: 'session-1',
      providerId: 'claude',
    })
    controller.dispose()
    await settle()
    expect((await client.commands.getScratchpad('workspace-1')).content).toBe('A\nb\none\ntwo\n')
    // Saved, so nothing is left waiting on the device.
    expect(seen.get(scratchpadUnsavedKey('env-1', 'workspace-1')) ?? '').toBe('')
  })

  it('keeps text a closed panel could not save, for the next panel to save', async () => {
    const seen = memoryStore()
    const first = setup({ content: 'one\n', seen })
    await first.controller.load()
    const original = first.client.commands.saveScratchpad
    first.client.commands.saveScratchpad = () => Promise.reject(new Error('offline'))
    first.controller.edit('one\ntwo\n')
    first.controller.dispose()
    await first.settle()
    expect(seen.get(scratchpadUnsavedKey('env-1', 'workspace-1'))).toContain('one\\ntwo')
    first.client.commands.saveScratchpad = original
    const again = createScratchpadController({
      client: first.client,
      workspaceId: 'workspace-1',
      environmentId: 'env-1',
      seen,
      saveDelayMs: 0,
    })
    expect(again.getSnapshot().content).toBe('')
    await again.load()
    expect(again.getSnapshot().content).toBe('one\ntwo\n')
    await first.settle()
    expect((await first.client.commands.getScratchpad('workspace-1')).content).toBe('one\ntwo\n')
    expect(again.getSnapshot().saveState).toBe('saved')
    expect(seen.get(scratchpadUnsavedKey('env-1', 'workspace-1'))).toBe('')
  })

  it('never merges into a file grown too large to show, and keeps the text', async () => {
    const { client, controller, view, settle } = setup({ content: 'notes\n' })
    await controller.load()
    controller.edit('notes\nmine\n')
    // An agent grows the file past the cap before the save goes out.
    const large = 'x'.repeat(SCRATCHPAD_MAX_BYTES + 10)
    client.editScratchpad('workspace-1', large, {
      kind: 'agent',
      sessionId: 'session-1',
      providerId: 'claude',
    })
    await settle()
    expect(view()).toMatchObject({
      content: 'notes\nmine\n',
      tooLarge: false,
      saveState: 'error',
      error: expect.stringContaining('too large'),
    })
    // Only the refused save went out; nothing was written over the agent's notes.
    expect(client.calls.filter((call) => call.command === 'saveScratchpad')).toHaveLength(1)
    expect((await client.commands.getScratchpad('workspace-1')).tooLarge).toBe(true)
  })

  it('refuses text too large to save before sending it, counting escapes', async () => {
    const { client, controller, view, settle } = setup()
    await controller.load()
    // 45,000 bytes on disk, more than the cap once quoted for the wire.
    controller.edit('"\\\n'.repeat(15_000))
    await settle()
    expect(view().saveState).toBe('error')
    expect(client.calls.some((call) => call.command === 'saveScratchpad')).toBe(false)
  })

  it('turns sharing with agents off and on', async () => {
    const { controller, view } = setup()
    await controller.load()
    await controller.setShareWithAgents(false)
    expect(view().shareWithAgents).toBe(false)
  })
})

// One store for every render: the hook makes a new controller for a new one.
const probeSeen = memoryStore()

function Probe({
  workspaceId,
  onView,
}: {
  workspaceId: string | null
  onView: (view: ScratchpadView) => void
}) {
  onView(useScratchpad(workspaceId, { seen: probeSeen, saveDelayMs: 0 }))
  return null
}

describe('useScratchpad', () => {
  let root: Root | null = null
  afterEach(() => {
    act(() => root?.unmount())
    root = null
  })

  const mount = async (client: MockEnvironmentClient, workspaceId: string | null) => {
    let latest: ScratchpadView | null = null
    const host = document.createElement('div')
    root = createRoot(host)
    act(() => {
      root!.render(
        <EnvironmentClientProvider client={client}>
          <Probe workspaceId={workspaceId} onView={(view) => (latest = view)} />
        </EnvironmentClientProvider>,
      )
    })
    // The read the mount's effect started.
    await act(async () => {
      for (let i = 0; i < 5; i += 1) {
        await client.settle()
        await tick()
      }
    })
    return () => latest!
  }

  it('reads the project’s scratchpad and follows its changes', async () => {
    const client = createMockEnvironmentClient({ seed: { workspaces: [WORKSPACE] } })
    client.editScratchpad('workspace-1', 'hello\n')
    const view = await mount(client, 'workspace-1')
    expect(view()).toMatchObject({ supported: true, content: 'hello\n' })
    await act(async () => {
      client.editScratchpad('workspace-1', 'hello\nagain\n')
    })
    expect(view()).toMatchObject({ content: 'hello\nagain\n', unseen: { before: 'hello\n' } })
  })

  it('is unsupported on an environment without scratchpads', async () => {
    const client = createMockEnvironmentClient({
      seed: { workspaces: [WORKSPACE] },
      capabilities: ['getEnvironment', 'listWorkspaces'],
    })
    const view = await mount(client, 'workspace-1')
    expect(view().supported).toBe(false)
    expect(client.calls.some((call) => call.command === 'getScratchpad')).toBe(false)
  })
})
