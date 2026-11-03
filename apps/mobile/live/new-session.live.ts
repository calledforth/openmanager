import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join } from 'node:path'
import { createElement, useLayoutEffect, useState, useSyncExternalStore } from 'react'
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
import type { ComposerModel } from '../src/composer/model'
import type { ProjectSource } from '../src/composer/ProjectSheet'
import { createSource, relaunchedStorage } from '../tests/support'

/**
 * A new session from the phone, end to end, against a real environment
 * server: pair, connect through the phone's controller, mount the shared
 * application providers on its client with the phone's own navigation and
 * landing route (as `PhoneEnvironmentProvider` does), then drive the
 * new-session page's own hooks: browse from the environment's start folder,
 * add a project, pick a model, write the first prompt and send it. An owner
 * client (as web) checks what it sees: the project at once, then the
 * session in that project with the phone's picks.
 *
 * LIVE_SERVER     the server's loopback URL, e.g. http://127.0.0.1:43461
 * LIVE_DATA_DIR   the server's data directory (for its owner credential)
 * LIVE_WORKSPACE  a scratch folder to add as the project
 * LIVE_APP_ORIGIN the origin its --allowed-origin lists
 * LIVE_OUT        where to write the JSON record
 */
vi.mock('react-native', () => ({ NativeModules: {}, Platform: { OS: 'android' } }))
const live = vi.hoisted(() => ({ controller: null as PhoneConnectionController | null }))
vi.mock('../src/environment/PhoneEnvironmentProvider', () => ({
  usePhoneConnection: () =>
    useSyncExternalStore(live.controller!.subscribe, live.controller!.getState),
}))

const SERVER = process.env.LIVE_SERVER ?? 'http://127.0.0.1:43461'
const DATA_DIR = process.env.LIVE_DATA_DIR ?? ''
const WORKSPACE_PATH = process.env.LIVE_WORKSPACE ?? ''
const APP_ORIGIN = process.env.LIVE_APP_ORIGIN ?? 'https://app.example.test'
const OUT = process.env.LIVE_OUT

const started = Date.now()
const record: Array<Record<string, unknown>> = []
const note = (event: string, detail: Record<string, unknown> = {}) => {
  const entry = { t: Date.now() - started, event, ...detail }
  record.push(entry)
  console.log(JSON.stringify(entry))
}
const frames: Array<{ direction: 'out' | 'in'; name: string; t: number }> = []
const NodeWebSocket = globalThis.WebSocket

/** Node's WebSocket with React Native's constructor shape; every frame's name noted. */
class PhoneWebSocket extends NodeWebSocket {
  constructor(
    url: string,
    protocols?: string | string[],
    options?: { headers?: Record<string, string> },
  ) {
    super(url, { protocols, headers: options?.headers } as never)
  }
  send(data: string) {
    const message = JSON.parse(data) as { name?: string }
    if (message.name) frames.push({ direction: 'out', name: message.name, t: Date.now() - started })
    super.send(data)
  }
}
const sentSince = (since: number) =>
  frames.filter((frame) => frame.direction === 'out' && frame.t >= since).map((f) => f.name)

async function until(label: string, read: () => boolean, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!read()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

async function installDom() {
  const fromVitest = createRequire(createRequire(import.meta.url).resolve('vitest/package.json'))
  type Dom = { window: Window & typeof globalThis }
  const { JSDOM } = fromVitest('jsdom') as {
    JSDOM: new (html: string, options: { url: string }) => Dom
  }
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/' })
  const scope = globalThis as Record<string, unknown>
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

describe('a new session from the phone, live', () => {
  it('adds a project web sees at once, and starts a session web sees with its picks', async () => {
    const dom = await installDom()
    const { act } = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { EnvironmentApplicationProviders, EnvironmentClientProvider, useSessionState } =
      await import('@openmanager/app-core/logic')
    const { createPhoneConnectionController } = await import('../src/environment/controller')
    const { landingOf } = await import('../src/environment/landing-route')
    const { createPhoneNavigation } = await import('../src/environment/navigation')
    const { useLiveComposerModel } = await import('../src/composer/useLiveComposerModel')
    const { ThreadBridge } = await import('../src/composer/thread-port')
    const { useProjectSource } = await import('../src/draft/useProjectSource')
    const { useReadOnlySession } = await import('../src/session/useReadOnlySession')

    // ---- the owner, as web --------------------------------------------
    const ownerCredential = readFileSync(join(DATA_DIR, 'owner-credential'), 'utf8').trim()
    const owner = createWebSocketEnvironmentClient({
      url: `${SERVER.replace('http:', 'ws:')}/ws`,
      credential: ownerCredential,
      WebSocket: NodeWebSocket as unknown as WebSocketConstructor,
    })
    cleanups.push(() => owner.dispose())
    owner.connect()
    await until('owner connected', () => owner.getState().connection.phase === 'connected')
    // Add project starts in the scratch folder's parent, so the phone walks into it.
    await owner.commands.setEnvironmentSettings({ addProjectStartsIn: dirname(WORKSPACE_PATH) })
    const { token } = await owner.commands.createPairingLink({
      capabilities: ['read', 'operate', 'agent'],
      label: 'New session live check',
    })
    const paired = await exchangePairingToken(SERVER, { token, label: 'New session live check' })

    // ---- the phone ------------------------------------------------------
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

    let model: ComposerModel | null = null
    let projects: ProjectSource | null = null
    let draftOpen = false
    let projectPath: string | null = null
    let path = '/draft/new'
    let replyRows = 0
    const moves: string[] = []
    // The session's page, as the route mounts it once the launch lands there.
    function SessionPage({ sessionId }: { sessionId: string }) {
      const view = useReadOnlySession(sessionId)
      replyRows = view.messages.filter((message) => message.role === 'assistant').length
      return null
    }
    function Page() {
      const composer = useLiveComposerModel(null)
      model = composer.model
      projects = useProjectSource()
      const session = useSessionState()
      draftOpen = session.isSessionDraftOpen
      projectPath = session.activeWorkspacePath
      return createElement(ThreadBridge, { port: composer.port })
    }
    // The phone's root, over an in-memory address in place of expo-router.
    function Root() {
      const [address, setAddress] = useState('/draft/new')
      const [navigation] = useState(() =>
        createPhoneNavigation({
          push: (href) => (moves.push(`push ${href}`), setAddress(href)),
          replace: (href) => (moves.push(`replace ${href}`), setAddress(href)),
          setParams: (params) => (
            moves.push(`setParams ${JSON.stringify(params)}`),
            setAddress(`/draft/${params.draftId}`)
          ),
        }),
      )
      useLayoutEffect(() => navigation.arrived(address), [address, navigation])
      path = address
      const landing = landingOf(address)
      return createElement(EnvironmentClientProvider, {
        client,
        children: createElement(EnvironmentApplicationProviders, {
          storage: null,
          navigateSession: navigation.navigateSession,
          navigateDraft: navigation.navigateDraft,
          onLanding: landing.onLanding,
          landingDraftId: landing.draftId,
          children: landing.onLanding
            ? createElement(Page)
            : address.startsWith('/session/')
              ? createElement(SessionPage, {
                  sessionId: decodeURIComponent(address.slice('/session/'.length)),
                })
              : null,
        }),
      })
    }
    const root = createRoot(dom.window.document.getElementById('root')!)
    await act(() => root.render(createElement(Root)))
    cleanups.push(() => root.unmount())
    const tick = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 50)))
    const wait = async (label: string, read: () => boolean, ms = 60_000) => {
      await until(label, read, ms)
      await tick()
    }
    await wait('draft open', () => draftOpen && !!projects?.browse && !!projects?.add)

    // ---- 1. browse from the environment's start folder, add the project -
    let since = Date.now() - started
    const listing = await act(() => projects!.browse!())
    note('browse', {
      path: listing.path,
      entries: listing.entries.map((entry) => entry.name),
      sent: sentSince(since),
    })
    expect(sentSince(since)).toEqual(['filesystem.browse'])
    const entry = listing.entries.find((each) => each.name === basename(WORKSPACE_PATH))
    expect(entry).toBeTruthy()
    const inside = await act(() => projects!.browse!(entry!.path))
    since = Date.now() - started
    await act(() => projects!.add!(inside.path))
    // Web's sidebar: the owner's client has it once the phone's add has answered.
    const added = Object.values(owner.getState().workspaces).find(
      (workspace) => workspace.path === inside.path,
    )
    note('added', { workspace: added, sent: sentSince(since) })
    expect(added).toBeTruthy()
    await wait('project picked', () => projectPath === added!.path)

    // ---- 2. picks, the first prompt, send ------------------------------
    await wait('picks', () => model!.groups.some((group) => group.models.length > 1), 60_000)
    // Claude Code where the environment has it (it answers reliably), else the draft's own provider.
    const group =
      model!.groups.find((each) => each.providerId === 'claude' && each.models.length > 1) ??
      model!.groups.find((each) => each.providerId === model!.picks.providerId)!
    const pick = group.models.find((each) => each.id !== model!.currentModelId)!
    await act(async () => model!.pickModel(group.providerId, pick.id))
    await wait(
      'model picked',
      () => model!.picks.providerId === group.providerId && model!.currentModelId === pick.id,
    )
    note('picks', { ...model!.picks, modelId: model!.currentModelId })

    since = Date.now() - started
    await act(async () => model!.setText('Reply with exactly the word pong.'))
    await wait('draft address', () => path.startsWith('/draft/') && path !== '/draft/new')
    await wait('send enabled', () => model!.primary.kind === 'send' && model!.primary.enabled)
    await act(async () => model!.send())
    await wait('landed on the session', () => path.startsWith('/session/'), 120_000)
    const sessionId = decodeURIComponent(path.slice('/session/'.length))
    note('sent', { sent: sentSince(since), moves, sessionId })
    expect(sentSince(since)).toContain('session.create')
    // The session's page opens it (the launch only selected it), so the reply streams in.
    // The reply's own words (an unsettled turn has an empty assistant row).
    const replyText = () =>
      Object.values(client.getState().threads)
        .filter((thread) => thread.thread.sessionId === sessionId)
        .flatMap((thread) => thread.messages)
        .filter((message) => message.role === 'assistant')
        .flatMap((message) => message.content ?? [])
        .map((part) => ('text' in part && typeof part.text === 'string' ? part.text : ''))
        .join(' ')
    await wait('the reply on the session page', () => /pong/i.test(replyText()), 180_000)
    note('replied', { replyRows, reply: replyText(), sent: sentSince(since) })
    expect(replyRows).toBeGreaterThan(0)
    expect(sentSince(since)).toContain('session.open')

    // ---- 3. what web sees ----------------------------------------------
    await until('owner sees the session', () => !!owner.getState().sessions[sessionId], 30_000)
    const seen = owner.getState().sessions[sessionId]!
    await until('owner sees its picks', () => !!owner.getState().sessions[sessionId]?.composer)
    const composer = owner.getState().sessions[sessionId]!.composer
    note('owner.session', {
      workspaceId: seen.workspaceId,
      providerId: seen.providerId,
      composer,
    })
    expect(seen.workspaceId).toBe(added!.workspaceId)
    expect(seen.providerId).toBe(group.providerId)
    expect(composer?.modelId).toBe(pick.id)
  }, 300_000)
})
