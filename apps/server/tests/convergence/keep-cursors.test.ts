/**
 * Kept cursors: a client with an up-to-date copy resumes from it, across a
 * chat switch and a reload, and the screen still equals a fresh load (rule 6).
 * Every scenario reads what crossed the wire, so "resumed" is never assumed.
 */
import { describe, expect } from 'vitest'
import { cacheState } from '@openmanager/environment-client'
import type { ProviderOp } from './child-protocol.ts'
import { expectConverges } from './evidence.ts'
import { Driver, until, type EnvironmentState, type Rig, type TestClient } from './harness.ts'
import type { FrameRecord } from './link-proxy.ts'
import { scenario } from './scenario.ts'
import {
  createSession,
  scriptedTurn,
  startTurn,
  thread,
  untilThread,
  type Target,
} from './steps.ts'

const QUIET = { quiet: true } as const
const SCRIPT: ProviderOp = {
  op: 'setAutoScript',
  steps: [
    { op: 'thought', text: 'Working out the next step' },
    { op: 'tool', status: 'completed', title: 'Read file' },
    { op: 'text', text: 'Step done, with enough words that a whole chat outweighs one turn.' },
    { op: 'complete' },
  ],
}

interface Asked {
  scope: { type: string; sessionId?: string; threadId?: string }
  hadCursor: boolean
  mode?: string
  reason?: string
  events?: number
}

/** Every catch-up asked on the wire since `mark`, joined with its answer. */
function catchUps(rig: Rig, mark: number): Asked[] {
  const frames: FrameRecord[] = rig.proxy.frames.slice(mark)
  const asked = new Map<string, Asked>()
  for (const frame of frames) {
    const json = frame.json as
      | {
          type?: string
          name?: string
          requestId?: string
          payload?: {
            scope?: Asked['scope']
            cursor?: unknown
            mode?: string
            reason?: string
            events?: unknown[]
          }
        }
      | undefined
    if (frame.direction === 'up' && json?.name === 'subscription.replay') {
      asked.set(json.requestId!, {
        scope: json.payload!.scope!,
        hadCursor: json.payload!.cursor !== null,
      })
    } else if (frame.direction === 'down') {
      const requestId = json?.requestId ?? frame.fields?.requestId
      const entry = requestId ? asked.get(requestId) : undefined
      if (!entry) continue
      entry.mode = json?.payload?.mode ?? frame.fields?.mode
      entry.reason = json?.payload?.reason ?? frame.fields?.reason
      entry.events = json?.payload?.events?.length
    }
  }
  return [...asked.values()]
}

const ofThread = (asked: Asked[], target: Target) =>
  asked.filter((item) => item.scope.threadId === target.threadId)
const ofEnvironment = (asked: Asked[]) => asked.filter((item) => item.scope.type === 'environment')
const answered = async (
  rig: Rig,
  client: TestClient,
  mark: number,
  what: (a: Asked[]) => Asked[],
) =>
  until(() => {
    const found = what(catchUps(rig, mark))
    return found.length > 0 && found.every((item) => item.mode) ? found : undefined
  }, `the catch-up to be answered for ${client.name}`)

/** A chat long enough that a short replay beats its snapshot, and a second to switch to. */
async function twoChats(rig: Rig, a: TestClient) {
  await rig.provider(SCRIPT)
  const other = await createSession(rig, a, QUIET)
  const target = await createSession(rig, a, QUIET)
  for (let turn = 0; turn < 6; turn++) await scriptedTurn(a, target, `Turn ${turn}`)
  await rig.settle()
  return { target, other }
}

/** A second device, on its own link, that writes while A is away. */
async function elsewhere(rig: Rig) {
  const driver = new Driver(rig)
  return { client: await driver.client(20), dispose: () => driver.dispose() }
}

describe('kept cursors', () => {
  scenario('KC1 switch away and back, nothing changed: no snapshot', {}, async (rig) => {
    const a = await rig.connect('A')
    const { target, other } = await twoChats(rig, a)
    await a.client.commands.openSession(other.sessionId)
    await rig.settle()
    const mark = rig.proxy.frames.length
    await a.client.commands.openSession(target.sessionId)
    const [answer] = await answered(rig, a, mark, (asked) => ofThread(asked, target))
    expect(answer).toMatchObject({ hadCursor: true, mode: 'replay', events: 0 })
    await expectConverges('KC1', rig, a)
  })

  scenario('KC2 switch away and back after a gap: the gap only', {}, async (rig) => {
    const a = await rig.connect('A')
    const { target, other } = await twoChats(rig, a)
    await a.client.commands.openSession(other.sessionId)
    await rig.settle()
    const b = await elsewhere(rig)
    await b.client.client.commands.openSession(target.sessionId)
    await scriptedTurn(b.client, target, 'Written while A was away')
    await rig.settle()
    b.dispose()
    const mark = rig.proxy.frames.length
    await a.client.commands.openSession(target.sessionId)
    const [answer] = await answered(rig, a, mark, (asked) => ofThread(asked, target))
    expect(answer).toMatchObject({ hadCursor: true, mode: 'replay' })
    expect(answer!.events).toBeGreaterThan(0)
    await expectConverges('KC2', rig, a)
  })

  scenario('KC3 leaving and reloading in the middle of a stream', {}, async (rig) => {
    const a = await rig.connect('A')
    const { target, other } = await twoChats(rig, a)
    await rig.provider({ op: 'setAutoScript', steps: null })
    const turnId = await startTurn(a, target, 'A long one')
    await rig.provider({ op: 'emitText', sessionId: target.sessionId, text: 'Half of it. ' })
    await rig.provider({ op: 'emitThought', sessionId: target.sessionId, text: 'Thinking on.' })
    await untilThread(
      a,
      target,
      (state) => JSON.stringify(state.messages).includes('Half of it.'),
      'the first half to reach A',
    )
    await a.client.commands.openSession(other.sessionId)
    await rig.provider({ op: 'emitText', sessionId: target.sessionId, text: 'The other half. ' })
    await a.client.commands.openSession(target.sessionId)
    const reloaded = await rig.reload(a)
    await rig.provider({ op: 'emitText', sessionId: target.sessionId, text: 'And the end.' })
    await rig.provider({ op: 'completeTurn', sessionId: target.sessionId })
    await untilThread(
      reloaded,
      target,
      (state) => state.turns.find((turn) => turn.turnId === turnId)?.state === 'completed',
      'the turn to finish on the reloaded client',
    )
    await expectConverges('KC3', rig, reloaded)
    // Each delta exactly once: a cursor behind its state would repeat one.
    const text = JSON.stringify(thread(reloaded, target)?.messages)
    expect(text.match(/Half of it\./g)).toHaveLength(1)
    expect(text.match(/The other half\./g)).toHaveLength(1)
  })

  scenario('KC4 reload after a gap: the sidebar arrives by replay', {}, async (rig) => {
    const a = await rig.connect('A')
    const { target } = await twoChats(rig, a)
    // An environment snapshot big enough that a short gap replays.
    for (let index = 0; index < 8; index++) await createSession(rig, a, { open: false })
    const second = await a.client.commands.addWorkspace({ path: await rig.folder('second') })
    // A preference the gap does not touch: only the copy can bring it back.
    await a.client.commands.setComposerPreference({
      workspaceId: second.workspaceId,
      providerId: 'opencode',
      preference: { modelId: 'kept-model' },
    })
    await a.client.commands.openSession(target.sessionId)
    await rig.settle()
    // The copy the page saved; everything below happens after it.
    const saved = structuredClone(a.store.getServerState())
    const b = await elsewhere(rig)
    const { commands } = b.client.client
    await commands.renameSession(target.sessionId, 'Renamed while reloading')
    await commands.setComposerPreference({
      workspaceId: rig.workspaceId,
      providerId: 'opencode',
      preference: { modelId: 'newer-model' },
    })
    await commands.saveDraft({
      draftId: target.sessionId,
      baseRevision: 0,
      target: { type: 'session', sessionId: target.sessionId },
      content: { text: 'Typed on the other device' },
    })
    await rig.settle()
    b.dispose()
    const mark = rig.proxy.frames.length
    const reloaded = await rig.reload(a, 'proxy', true, () => cacheState(saved))
    const environment = await answered(rig, reloaded, mark, ofEnvironment)
    expect(environment.at(-1)).toMatchObject({ hadCursor: true, mode: 'replay' })
    const [answer] = await answered(rig, reloaded, mark, (asked) => ofThread(asked, target))
    expect(answer!.hadCursor).toBe(true)
    await expectConverges('KC4', rig, reloaded)
    // Replay brings changes only; what did not change must have survived.
    const { composerPreferences, drafts } = reloaded.client.getState()
    expect(composerPreferences[second.workspaceId]?.opencode?.modelId).toBe('kept-model')
    expect(composerPreferences[rig.workspaceId]?.opencode?.modelId).toBe('newer-model')
    expect(drafts[target.sessionId]?.content.text).toBe('Typed on the other device')
  })

  scenario(
    'KC4b an event right behind the session.open answer, whole TCP reads',
    {},
    async (rig) => {
      // Every message of a read at once: the answer's continuation runs after
      // the event behind it, so only the answer's stated position can place it.
      rig.synchronousDelivery = true
      const a = await rig.connect('A')
      const target = await createSession(rig, a, QUIET)
      await createSession(rig, a, { ...QUIET, open: false })
      await a.client.commands.openSession(target.sessionId)
      await rig.settle()
      const saved = structuredClone(a.store.getServerState())
      const b = await elsewhere(rig)
      // The reopen below reports this preference as the chat's selection, in a
      // `session.composer.updated` that follows the answer on the wire.
      await b.client.client.commands.setComposerPreference({
        workspaceId: rig.workspaceId,
        providerId: 'opencode',
        preference: { modelId: 'newer-model' },
      })
      await rig.settle()
      b.dispose()
      const mark = rig.proxy.frames.length
      // Bytes leave the proxy on its ticks, so frames milliseconds apart reach
      // the client as one read.
      rig.proxy.latency(20)
      const reloaded = await rig.reload(a, 'proxy', true, () => cacheState(saved))
      await rig.settle()
      const event = (name: string) =>
        rig.proxy.frames
          .slice(mark)
          .findIndex((frame) => JSON.stringify(frame.json ?? frame.fields ?? '').includes(name))
      expect(event('session.composer.updated')).toBeGreaterThan(-1)
      await expectConverges('KC4b', rig, reloaded)
      expect(thread(reloaded, target)?.cursor).toBeDefined()
      expect(reloaded.client.getState().sessions[target.sessionId]?.composer?.modelId).toBe(
        'newer-model',
      )
    },
  )

  scenario('KC5 reload with no gap: nothing comes down whole', {}, async (rig) => {
    const a = await rig.connect('A')
    const { target } = await twoChats(rig, a)
    await a.client.commands.openSession(target.sessionId)
    await rig.settle()
    const mark = rig.proxy.frames.length
    const reloaded = await rig.reload(a)
    const expected = (asked: Asked[]) => (asked.length >= 3 ? asked : [])
    const answers = await answered(rig, reloaded, mark, expected)
    expect(answers.map((item) => item.scope.type).sort()).toEqual([
      'environment',
      'session',
      'thread',
    ])
    for (const answer of answers) {
      expect(answer).toMatchObject({ hadCursor: true, mode: 'replay', events: 0 })
    }
    await expectConverges('KC5', rig, reloaded)
  })

  scenario('KC6 the chat is deleted while away, then a reload', {}, async (rig) => {
    const a = await rig.connect('A')
    const { target, other } = await twoChats(rig, a)
    await a.client.commands.openSession(other.sessionId)
    await rig.settle()
    expect(thread(a, target)?.cursor).toBeDefined()
    const saved = structuredClone(a.store.getServerState())
    const b = await elsewhere(rig)
    await b.client.client.commands.deleteSession(target.sessionId)
    b.dispose()
    await rig.settle()
    // A copy saved before the deletion, with the deleted chat on screen.
    const reloaded = await rig.reload(a, 'proxy', true, () =>
      cacheState({ ...saved, activeSessionId: target.sessionId, activeThreadId: target.threadId }),
    )
    await until(
      () => reloaded.client.getState().sessions[target.sessionId] === undefined,
      'the deletion to reach the reloaded client',
    )
    await rig.settle()
    expect(reloaded.store.getServerState().threads[target.threadId]).toBeUndefined()
    expect(reloaded.store.getServerState().cursors.sessions[target.sessionId]).toBeUndefined()
    await expectConverges('KC6', rig, reloaded)
    // And it stays gone from every later reconnect.
    const mark = rig.proxy.frames.length
    const before = reloaded.connects
    rig.proxy.cut()
    await until(() => reloaded.connects > before, 'the client to reconnect')
    await rig.settle()
    expect(ofThread(catchUps(rig, mark), target)).toEqual([])
  })

  scenario('KC7 a cached cursor below the replay floor: a snapshot', {}, async (rig) => {
    const a = await rig.connect('A')
    const { target, other } = await twoChats(rig, a)
    await a.client.commands.openSession(other.sessionId)
    await rig.settle()
    const b = await elsewhere(rig)
    await b.client.client.commands.openSession(target.sessionId)
    await scriptedTurn(b.client, target, 'Below the floor now')
    await rig.settle()
    b.dispose()
    await rig.server.call({ op: 'raiseReplayFloor', threadId: target.threadId })
    const reloaded = await rig.reload(a)
    const mark = rig.proxy.frames.length
    await reloaded.client.commands.openSession(target.sessionId)
    const [answer] = await answered(rig, reloaded, mark, (asked) => ofThread(asked, target))
    expect(answer).toMatchObject({ hadCursor: true, mode: 'snapshot', reason: 'gap_expired' })
    await expectConverges('KC7', rig, reloaded)
  })

  scenario(
    'KC8 a restart keeps the stream; a stale epoch or a future cursor does not',
    {},
    async (rig) => {
      const a = await rig.connect('A')
      const { target } = await twoChats(rig, a)
      await a.client.commands.openSession(target.sessionId)
      await rig.settle()
      // Streams keep their epoch across a restart: the chat resumes.
      let mark = rig.proxy.frames.length
      await rig.restart()
      let [answer] = await answered(rig, a, mark, (asked) => ofThread(asked, target))
      expect(answer).toMatchObject({ hadCursor: true, mode: 'replay' })
      await expectConverges('KC8 restart', rig, a)

      const shifted =
        (patch: (cursor: { epoch: string; sequence: number }) => object) =>
        (state: EnvironmentState) => ({
          ...state,
          threads: {
            ...state.threads,
            [target.threadId]: {
              ...state.threads[target.threadId]!,
              cursor: {
                ...state.threads[target.threadId]!.cursor!,
                ...patch(state.threads[target.threadId]!.cursor!),
              },
            },
          },
        })
      mark = rig.proxy.frames.length
      const stale = await rig.reload(
        a,
        'proxy',
        true,
        shifted(() => ({ epoch: 'an-older-epoch' })),
      )
      ;[answer] = await answered(rig, stale, mark, (asked) => ofThread(asked, target))
      expect(answer).toMatchObject({ hadCursor: true, mode: 'snapshot', reason: 'stream_reset' })
      await expectConverges('KC8 epoch', rig, stale)

      mark = rig.proxy.frames.length
      const ahead = await rig.reload(
        stale,
        'proxy',
        true,
        shifted(({ sequence }) => ({ sequence: sequence + 1_000 })),
      )
      ;[answer] = await answered(rig, ahead, mark, (asked) => ofThread(asked, target))
      expect(answer).toMatchObject({ hadCursor: true, mode: 'snapshot', reason: 'cursor_ahead' })
      await expectConverges('KC8 ahead', rig, ahead)
    },
  )

  scenario('KC9 a notice does not outlive a replay', {}, async (rig) => {
    const a = await rig.connect('A')
    const { target, other } = await twoChats(rig, a)
    await rig.provider({ op: 'setAutoScript', steps: null })
    await startTurn(a, target, 'Draw something')
    await rig.provider({ op: 'emitUnstorableImage', sessionId: target.sessionId })
    await untilThread(a, target, (state) => state.notices.length === 1, 'the notice to arrive')
    await rig.provider({ op: 'completeTurn', sessionId: target.sessionId })
    await rig.settle()
    await a.client.commands.openSession(other.sessionId)
    await rig.settle()
    const mark = rig.proxy.frames.length
    await a.client.commands.openSession(target.sessionId)
    const [answer] = await answered(rig, a, mark, (asked) => ofThread(asked, target))
    expect(answer).toMatchObject({ hadCursor: true, mode: 'replay' })
    // A fresh load has none: the server never stored it.
    expect(thread(a, target)?.notices).toEqual([])
    await expectConverges('KC9', rig, a)
  })
})
