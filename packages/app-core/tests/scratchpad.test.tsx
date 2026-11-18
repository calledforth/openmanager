// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  createMockEnvironmentClient,
  type MockEnvironmentClient,
} from '@openmanager/environment-client'
import type { Workspace } from '@openmanager/protocol'
import { EnvironmentClientProvider } from '../src/providers/environment-client'
import { mergeLines } from '../src/lib/scratchpad/merge'
import {
  createScratchpadController,
  scratchpadSeenKey,
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
