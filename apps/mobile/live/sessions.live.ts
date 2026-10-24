import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { createElement, useSyncExternalStore, type ReactNode } from 'react'
import { afterAll, describe, expect, it, vi } from 'vitest'
import {
  createWebSocketEnvironmentClient,
  type EnvironmentClient,
  type WebSocketConstructor,
} from '@openmanager/environment-client'
import { exchangePairingToken } from '@openmanager/environment-client/connection'
import type {
  AppActivity,
  PhoneConnectionController,
  PhoneNetwork,
} from '../src/environment/controller'
import { createSource, relaunchedStorage } from '../tests/support'

/**
 * The phone's sessions list and read-only thread, end to end, against a real
 * environment server: pair, connect through the phone's controller, mount the
 * shared application providers on its client exactly as
 * `PhoneEnvironmentProvider` does, read the home through `useHomeSource`,
 * open a session through `useReadOnlySession` (the page's own hook), watch a
 * live provider turn stream into its rows, leave, and check the wire: one
 * `session.open`, never `session.history`.
 *
 * React renders into a jsdom document (the one vitest's own jsdom runs on);
 * the probes render nothing, so no React Native view is involved. The socket
 * is Node's, taking React Native's constructor shape as in
 * `handshake.live.ts`.
 *
 * LIVE_SERVER    the server's loopback URL, e.g. http://127.0.0.1:43250
 * LIVE_DATA_DIR  the server's data directory (for its owner credential)
 * LIVE_APP_ORIGIN the origin its --allowed-origin lists
 * LIVE_PROVIDER  the provider for the live turn (default `claude`)
 * LIVE_PROMPTS   what the owner sends it, one turn each (a JSON array)
 * LIVE_OUT       where to write the JSON record
 * LIVE_THREAD_OUT where to write the opened thread's state, for the fixture
 */
vi.mock('react-native', () => ({ NativeModules: {}, Platform: { OS: 'android' } }))
const live = vi.hoisted(() => ({ controller: null as PhoneConnectionController | null }))
vi.mock('../src/environment/PhoneEnvironmentProvider', () => ({
  usePhoneConnection: () =>
    useSyncExternalStore(live.controller!.subscribe, live.controller!.getState),
}))

const SERVER = process.env.LIVE_SERVER ?? 'http://127.0.0.1:43250'
const DATA_DIR = process.env.LIVE_DATA_DIR ?? ''
const APP_ORIGIN = process.env.LIVE_APP_ORIGIN ?? 'https://app.example.test'
const PROVIDER = process.env.LIVE_PROVIDER ?? 'claude'
const PROMPTS = process.env.LIVE_PROMPTS
  ? (JSON.parse(process.env.LIVE_PROMPTS) as string[])
  : [
      'Read notes.md in this folder, then answer in two short markdown bullet points: what the file is, and its first line.',
      'List the files in this folder with a shell command, then write a short paragraph (about 80 words) on why a phone might show a coding session read-only before it can reply. End with a one-line markdown quote.',
    ]
const OUT = process.env.LIVE_OUT
const THREAD_OUT = process.env.LIVE_THREAD_OUT

const started = Date.now()
const record: Array<Record<string, unknown>> = []
const note = (event: string, detail: Record<string, unknown> = {}) => {
  const entry = { t: Date.now() - started, event, ...detail }
  record.push(entry)
  console.log(JSON.stringify(entry))
}

const frames: Array<{ socket: number; direction: 'out' | 'in'; name: string; t: number }> = []
let socketCount = 0
const NodeWebSocket = globalThis.WebSocket

/** Node's WebSocket with React Native's constructor shape; every frame's name noted. */
class PhoneWebSocket extends NodeWebSocket {
  readonly index: number
  constructor(
    url: string,
    protocols?: string | string[],
    options?: { headers?: Record<string, string> },
  ) {
    super(url, { protocols, headers: options?.headers } as never)
    this.index = ++socketCount
    const index = this.index
    note('socket.dial', { socket: index, url, origin: options?.headers?.origin ?? null })
    this.addEventListener('message', (event) => {
      try {
        const message = JSON.parse(String(event.data)) as {
          type: string
          name?: string
          payload?: { record?: { event?: { name?: string } } }
        }
        if (message.type === 'event' && message.name) {
          // A subscription's event carries the protocol event inside it.
          const name = message.payload?.record?.event?.name ?? message.name
          frames.push({ socket: index, direction: 'in', name, t: Date.now() - started })
        }
      } catch {
        /* not JSON */
      }
    })
  }
  send(data: string) {
    const message = JSON.parse(data) as { name?: string }
    if (message.name) {
      frames.push({
        socket: this.index,
        direction: 'out',
        name: message.name,
        t: Date.now() - started,
      })
    }
    super.send(data)
  }
}

/** Protocol events the phone received since `since` (ms into the run), by name. */
function eventCounts(since: number) {
  const counts: Record<string, number> = {}
  for (const frame of frames) {
    if (frame.direction === 'in' && frame.t >= since)
      counts[frame.name] = (counts[frame.name] ?? 0) + 1
  }
  return counts
}

async function until(label: string, read: () => boolean, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!read()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

/** A DOM for react-dom to mount into, from the jsdom vitest itself depends on. */
async function installDom() {
  const fromVitest = createRequire(createRequire(import.meta.url).resolve('vitest/package.json'))
  type Dom = { window: Window & typeof globalThis }
  const { JSDOM } = fromVitest('jsdom') as {
    JSDOM: new (html: string, options: { url: string }) => Dom
  }
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/' })
  const scope = globalThis as Record<string, unknown>
  // Only what react-dom reads: Node's own Event and EventTarget stay, as its
  // sockets dispatch them.
  scope.window = dom.window
  scope.document = dom.window.document
  scope.IS_REACT_ACT_ENVIRONMENT = true
  return dom
}

const cleanups: Array<() => void> = []
afterAll(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
  if (OUT) writeFileSync(OUT, JSON.stringify({ record, frames }, null, 2))
})

describe('sessions list and read-only thread, live', () => {
  it('lists the environment sessions, opens one, and streams a live turn into it', async () => {
    const dom = await installDom()
    const { act } = await import('react')
    const { createRoot } = await import('react-dom/client')
    const {
      EnvironmentApplicationProviders,
      EnvironmentClientProvider,
      useActiveThreadStores,
      useEnvironmentState,
    } = await import('@openmanager/app-core/logic')
    const { createPhoneConnectionController } = await import('../src/environment/controller')
    const { useHomeSource } = await import('../src/home/source')
    const { selectHomeRows } = await import('../src/home/rows')
    const { useReadOnlySession } = await import('../src/session/useReadOnlySession')
    const { threadRowsOf } = await import('../src/session/thread-rows')

    // ---- the owner, as web: two sessions in a workspace, a pairing link ----
    const ownerCredential = readFileSync(join(DATA_DIR, 'owner-credential'), 'utf8').trim()
    const owner = createWebSocketEnvironmentClient({
      url: `${SERVER.replace('http:', 'ws:')}/ws`,
      credential: ownerCredential,
      WebSocket: NodeWebSocket as unknown as WebSocketConstructor,
    })
    cleanups.push(() => owner.dispose())
    owner.connect()
    await until('owner connected', () => owner.getState().connection.phase === 'connected')
    await until('workspace listed', () => owner.getState().workspaceOrder.length > 0)
    const environmentId = owner.getState().environment!.environmentId
    const workspaceId = owner.getState().workspaceOrder[0]!
    const titles = ['Read the notes from the phone', 'A second session for the list']
    const createdIds: string[] = []
    for (const title of titles) {
      const created = await owner.commands.createSession({
        environmentId,
        workspaceId,
        providerId: PROVIDER,
        title,
      })
      createdIds.push(created.session.sessionId)
    }
    note('sessions.created', {
      by: 'owner',
      workspaceId,
      providerId: PROVIDER,
      sessions: createdIds,
    })
    const draftId = randomUUID()
    await owner.commands.saveDraft({
      draftId,
      baseRevision: 0,
      target: { type: 'new_session', workspaceId, sessionId: randomUUID() },
      content: {
        text: 'A draft started on the computer\nwith a second line',
        providerId: PROVIDER,
      },
    })
    note('draft.saved', { by: 'owner', draftId })
    const { token } = await owner.commands.createPairingLink({
      capabilities: ['read', 'operate', 'agent'],
      label: 'Sessions live check',
    })
    const paired = await exchangePairingToken(SERVER, { token, label: 'Sessions live check' })
    note('pairing.exchanged', { environmentId: paired.environmentId, clientId: paired.clientId })

    // ---- the phone's controller, as on a first launch -------------------
    const controller = createPhoneConnectionController({
      storage: relaunchedStorage({ selectedId: null, environments: [] }),
      activity: createSource<AppActivity>('active'),
      network: createSource<PhoneNetwork>({ online: true }),
      transport: {
        WebSocket: PhoneWebSocket as never,
        fetch: globalThis.fetch,
        requestId: () => randomUUID(),
      },
      warn: (message) => note('controller.warn', { message }),
    })
    live.controller = controller
    cleanups.push(() => controller.dispose())
    await controller.start()
    controller.saveEnvironment({
      environmentId: paired.environmentId,
      endpoint: SERVER,
      label: paired.label,
      credential: paired.credential,
      appOrigin: APP_ORIGIN,
    })
    await until('connected', () => controller.getState().status === 'connected')
    const client = controller.getState().client as EnvironmentClient
    note('connected', {
      status: controller.getState().status,
      endpoint: controller.getState().endpoint,
      protocol: controller.getState().protocol,
    })

    // ---- the shared providers on the phone's client, as the app mounts them
    type HomeView = ReturnType<typeof useHomeSource>
    type ThreadView = ReturnType<typeof useReadOnlySession> & {
      rows: ReturnType<typeof threadRowsOf>
    }
    let home: HomeView | null = null
    let thread: ThreadView | null = null
    const everything = <T>(state: T) => state
    function HomeProbe() {
      home = useHomeSource()
      return null
    }
    function ThreadProbe({ sessionId }: { sessionId: string }) {
      const view = useReadOnlySession(sessionId)
      const stores = useActiveThreadStores()
      // Each row on screen subscribes itself; the probe reads all of them.
      useEnvironmentState(everything)
      thread = { ...view, rows: threadRowsOf(stores, view.messages) }
      return null
    }
    const root = createRoot(dom.window.document.getElementById('root')!)
    const render = (page: ReactNode) =>
      act(() =>
        root.render(
          createElement(EnvironmentClientProvider, {
            client,
            children: createElement(EnvironmentApplicationProviders, {
              storage: null,
              // As PhoneEnvironmentProvider passes it: draft pages turn the cards on.
              navigateDraft: async () => undefined,
              children: [createElement(HomeProbe, { key: 'home' }), page],
            }),
          }),
        ),
      )
    const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 50)))
    cleanups.push(() => root.unmount())

    await render(null)
    // The catalog's older pages follow the first in the background, so on an
    // environment with a long history wait for the whole list, as the owner holds it.
    await until(
      'sidebar sessions and drafts',
      () =>
        (home?.sessions.length ?? 0) >=
          Math.max(createdIds.length, Object.keys(owner.getState().sessions).length) &&
        (home?.drafts.length ?? 0) > 0,
      60_000,
    )
    await settle()
    const server = owner.getState()
    const serverSessions = Object.values(server.sessions).map((session) => ({
      id: session.sessionId,
      title: session.title,
      status: session.status,
      workspaceId: session.workspaceId,
    }))
    const homeView = home as HomeView | null
    const rows = selectHomeRows({
      sessions: homeView!.sessions,
      workspaces: homeView!.workspaces,
      tab: 'all',
    })
    note('home', {
      kind: homeView!.kind,
      environment: homeView!.environment,
      connected: homeView!.connected,
      workspaces: homeView!.workspaces.map((workspace) => workspace.name),
      sessions: homeView!.sessions.map((session) => ({
        id: session.externalId,
        title: session.title,
        status: session.status,
        workspacePath: session.workspacePath,
      })),
      groups: rows.map((group) => ({
        label: group.label,
        rows: group.rows.map((row) => row.session.externalId),
      })),
      serverSessions,
      drafts: homeView!.drafts,
    })
    expect(
      homeView!.drafts.map((draft) => [draft.draftId, draft.preview, draft.workspaceId]),
    ).toContainEqual([draftId, 'A draft started on the computer', workspaceId])
    expect(homeView!.kind).toBe('environment')
    expect(homeView!.connected).toBe(true)
    expect(homeView!.environment).toMatchObject({
      environmentId: paired.environmentId,
      route: { kind: 'local' },
    })
    expect(
      homeView!.sessions
        .map((session) => [session.externalId, session.title, session.workspacePath])
        .sort(),
    ).toEqual(
      serverSessions.map((session) => [session.id, session.title, session.workspaceId]).sort(),
    )

    // ---- open the first: snapshot, then a live provider turn -------------
    const sessionId = createdIds[0]!
    const outBeforeOpen = frames.filter((frame) => frame.direction === 'out').length
    await render(createElement(ThreadProbe, { key: sessionId, sessionId }))
    await until('thread ready', () => (thread as ThreadView | null)?.phase === 'ready')
    const openCommands = frames
      .filter((frame) => frame.direction === 'out')
      .slice(outBeforeOpen)
      .map((frame) => frame.name)
    note('session.opened', {
      sessionId,
      commands: openCommands,
      phase: (thread as ThreadView | null)!.phase,
      rows: (thread as ThreadView | null)!.rows.length,
    })
    expect(openCommands).toContain('session.open')

    await owner.commands.openSession(sessionId)
    const ownerThread = owner.getState().sessions[sessionId]!.threadIds[0]!
    for (const [index, prompt] of PROMPTS.entries()) {
      const before = (thread as ThreadView | null)!.rows.length
      const turnAt = Date.now()
      await owner.commands.sendTurn({ sessionId, threadId: ownerThread, text: prompt })
      note('turn.sent', { turn: index + 1, by: 'owner', provider: PROVIDER, prompt })

      // Every distinct state of the phone's last row while the turn runs.
      const samples: Array<{
        t: number
        rows: number
        chars: number
        parts: string[]
        final: boolean
        status?: string
      }> = []
      let lastKey = ''
      await until(
        `turn ${index + 1} settled on the phone`,
        () => {
          const view = thread as ThreadView | null
          if (!view) return false
          const last = view.rows.at(-1)
          const parts = (last?.parts ?? []).map((part) =>
            part.type === 'tool'
              ? `tool:${String(part.tool)}:${String((part.state as { status?: string })?.status)}`
              : part.type,
          )
          const key = `${view.rows.length}|${last?.content.length}|${parts.join(',')}|${last?.isFinal}|${view.session?.status}`
          if (key !== lastKey) {
            lastKey = key
            samples.push({
              t: Date.now() - turnAt,
              rows: view.rows.length,
              chars: last?.content.length ?? 0,
              parts,
              final: last?.isFinal ?? false,
              status: view.session?.status,
            })
          }
          return view.rows.length >= before + 2 && last?.role === 'assistant' && last.isFinal
        },
        240_000,
      )
      await settle()
      const settled = thread as ThreadView | null
      const live = samples.filter((sample) => sample.rows >= before + 2 && !sample.final)
      note('turn.streamed', {
        turn: index + 1,
        ms: Date.now() - turnAt,
        samples,
        liveStates: live.length,
        rows: settled!.rows.slice(before).map((row) => ({
          role: row.role,
          isFinal: row.isFinal,
          content: row.content,
          parts: row.parts.map((part) => ({
            type: part.type,
            ...(part.type === 'tool'
              ? { tool: part.tool, status: (part.state as { status?: string })?.status }
              : {}),
          })),
        })),
        status: settled!.session?.status,
        events: eventCounts(turnAt - started),
      })
      expect(settled!.rows.at(-1)).toMatchObject({ role: 'assistant', isFinal: true })
      // The turn was on the phone before it finished: its prompt and a live row.
      expect(live.length).toBeGreaterThan(0)
    }
    if (THREAD_OUT) {
      const state = client.getState()
      const threadId = state.sessions[sessionId]!.threadIds[0]!
      writeFileSync(THREAD_OUT, JSON.stringify(state.threads[threadId], null, 2))
    }

    // ---- leave: the session is released --------------------------------
    const outBeforeLeave = frames.filter((frame) => frame.direction === 'out').length
    await render(null)
    await settle()
    await until('released', () => client.getState().activeSessionId === null)
    const leaveCommands = frames
      .filter((frame) => frame.direction === 'out')
      .slice(outBeforeLeave)
      .map((frame) => frame.name)
    note('session.left', {
      activeSessionId: client.getState().activeSessionId,
      commands: leaveCommands,
    })
    expect(leaveCommands).toContain('subscription.unsubscribe')

    const sentByPhone = frames
      .filter((frame) => frame.direction === 'out')
      .map((frame) => frame.name)
    const counts: Record<string, number> = {}
    for (const name of sentByPhone) counts[name] = (counts[name] ?? 0) + 1
    note('wire', { phoneCommands: counts, sessionHistory: counts['session.history'] ?? 0 })
    expect(counts['session.history'] ?? 0).toBe(0)
    expect(counts['session.open']).toBe(1)
  }, 300_000)
})
