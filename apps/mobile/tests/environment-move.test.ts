import { describe, expect, it } from 'vitest'
import {
  createMockEnvironmentClient,
  selectDraftContent,
  type MockEnvironmentClient,
  type MockSeed,
} from '@openmanager/environment-client'

import {
  createDraftMover,
  DRAFT_HANDOVER_WINDOW_MS,
  type MoveClient,
} from '../src/draft/environment-move'

const project = (name: string) => ({
  workspaceId: `C:/${name}`,
  name,
  path: `C:/${name}`,
  lastUsedAt: null,
  lastActivityAt: '2026-10-02T10:00:00.000Z',
  capabilities: { git: false },
  exists: true,
})

const DESK: MockSeed = { workspaces: [project('alpha')] }
const LAPTOP: MockSeed = { workspaces: [project('omega'), project('zeta')] }

async function settle(...clients: MockEnvironmentClient[]) {
  for (let round = 0; round < 6; round += 1) {
    for (const client of clients) await client.settle()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
}

async function setup() {
  const desk = createMockEnvironmentClient({ seed: DESK, draftSaveDebounceMs: 0 })
  const laptop = createMockEnvironmentClient({ seed: LAPTOP, draftSaveDebounceMs: 0 })
  await settle(desk, laptop)
  const clients: Record<string, MoveClient> = { desk, laptop }
  const onScreen = new Set<string>()
  const returns: string[] = []
  let now = 1_000
  let ids = 0
  const mover = createDraftMover({
    clientOf: (id) => clients[id],
    reachable: (id) => clients[id]?.getState().connection.phase === 'connected',
    labelOf: (id) => (id === 'desk' ? 'Desk' : 'Laptop'),
    // The project last picked there: the second of its list, to tell it from the first.
    landingWorkspaceOf: (state) => state.workspaceOrder[1] ?? state.workspaceOrder[0] ?? null,
    onScreen: (id, draftId) => onScreen.has(`${id}/${draftId}`),
    returnTo: (id, draftId) => returns.push(`${id}/${draftId}`),
    mintId: () => `copy-${++ids}`,
    now: () => now,
  })
  const write = async (draftId: string, text: string) => {
    desk.drafts!.edit(
      draftId,
      { type: 'new_session', workspaceId: 'C:/alpha', sessionId: `${draftId}-session` },
      { text },
    )
    await desk.drafts!.flush()
    await settle(desk)
  }
  return {
    desk,
    laptop,
    clients,
    mover,
    onScreen,
    returns,
    write,
    later: (ms: number) => {
      now += ms
    },
  }
}

describe('moving a new session to another environment', () => {
  it('copies the text into the last picked project there, and deletes the original once the copy is saved', async () => {
    const { desk, laptop, mover, write } = await setup()
    await write('d1', 'Fix the login page')

    const result = mover.choose('laptop', { environmentId: 'desk', draftId: 'd1' })
    expect(result).toEqual({ kind: 'moved', environmentId: 'laptop', draftId: 'copy-1' })
    const copy = laptop.getState()
    expect(selectDraftContent(copy, 'copy-1')?.text).toBe('Fix the login page')
    expect(copy.draftEdits['copy-1']?.target ?? copy.drafts['copy-1']?.target).toMatchObject({
      type: 'new_session',
      workspaceId: 'C:/zeta',
    })

    await settle(desk, laptop)
    mover.check()
    await settle(desk, laptop)
    expect(laptop.getState().drafts['copy-1']).toBeTruthy()
    expect(desk.getState().drafts.d1).toBeUndefined()
    expect(mover.pending().handovers).toEqual([])
  })

  it('keeps the original when it was written to after the copy', async () => {
    const { desk, laptop, mover, write } = await setup()
    await write('d1', 'Fix the login page')
    mover.choose('laptop', { environmentId: 'desk', draftId: 'd1' })
    // Another device writes to it before the copy lands.
    await write('d1', 'Fix the login page, and the signup page')
    await settle(desk, laptop)
    mover.check()
    await settle(desk, laptop)
    expect(selectDraftContent(desk.getState(), 'd1')?.text).toBe(
      'Fix the login page, and the signup page',
    )
    expect(laptop.getState().drafts['copy-1']).toBeTruthy()
  })

  it('keeps the original past the window, when another device may have written to it offline', async () => {
    const { desk, laptop, mover, write, later } = await setup()
    await write('d1', 'Fix the login page')
    await laptop.setConnection({ phase: 'reconnecting' })
    mover.choose('laptop', { environmentId: 'desk', draftId: 'd1' })
    later(DRAFT_HANDOVER_WINDOW_MS + 1)
    await laptop.setConnection({ phase: 'connected' })
    await settle(desk, laptop)
    mover.check()
    await settle(desk, laptop)
    expect(desk.getState().drafts.d1).toBeTruthy()
  })

  it('refuses an environment that is not connected, and a second move of the same draft', async () => {
    const { laptop, mover, write } = await setup()
    await write('d1', 'Fix the login page')
    await laptop.setConnection({ phase: 'reconnecting' })
    expect(mover.choose('laptop', { environmentId: 'desk', draftId: 'd1' })).toEqual({
      kind: 'refused',
      reason: "Laptop isn't connected. Try again once it is",
    })
    await laptop.setConnection({ phase: 'connected' })
    expect(mover.choose('laptop', { environmentId: 'desk', draftId: 'd1' }).kind).toBe('moved')
    expect(mover.choose('laptop', { environmentId: 'desk', draftId: 'd1' }).kind).toBe('refused')
  })

  it('opens the blank page there with nothing written, and lets an empty draft go once its page has', async () => {
    const { desk, laptop, mover, write, onScreen } = await setup()
    // Picks alone: whitespace, nothing to lose.
    await write('d1', '   ')
    onScreen.add('desk/d1')
    expect(mover.choose('laptop', { environmentId: 'desk', draftId: 'd1' })).toEqual({
      kind: 'moved',
      environmentId: 'laptop',
      draftId: null,
    })
    expect(Object.keys(laptop.getState().drafts)).toEqual([])
    // Still on screen: it stays.
    mover.check()
    await settle(desk)
    expect(desk.getState().drafts.d1).toBeTruthy()
    onScreen.delete('desk/d1')
    mover.check()
    await settle(desk)
    expect(desk.getState().drafts.d1).toBeUndefined()
  })

  it('goes to the blank page from a page with no draft at all', async () => {
    const { mover } = await setup()
    expect(mover.choose('laptop', null)).toEqual({
      kind: 'moved',
      environmentId: 'laptop',
      draftId: null,
    })
    expect(mover.notice()).toBeNull()
  })

  it('goes back to the original when the copy never reaches the other environment', async () => {
    const { clients, desk, mover, onScreen, returns, write } = await setup()
    await write('d1', 'Fix the login page')
    // An environment that takes the copy and then never has it: refused, say.
    const laptop = clients.laptop!
    const state = laptop.getState()
    clients.laptop = {
      getState: () => state,
      subscribe: () => () => undefined,
      supports: () => true,
      drafts: { ...laptop.drafts!, edit: () => undefined, flush: async () => undefined },
    } as MoveClient
    const result = mover.choose('laptop', { environmentId: 'desk', draftId: 'd1' })
    expect(result).toMatchObject({ kind: 'moved', draftId: 'copy-1' })
    onScreen.add('laptop/copy-1')
    mover.check()
    expect(returns).toEqual(['desk/d1'])
    expect(mover.notice()?.message).toBe(
      "The copy on Laptop wasn't saved. The draft is still on Desk",
    )
    expect(desk.getState().drafts.d1).toBeTruthy()
    mover.dispose()
  })
})
