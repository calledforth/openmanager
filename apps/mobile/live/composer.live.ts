import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import { createElement, useSyncExternalStore } from 'react'
import { afterAll, describe, expect, it, vi } from 'vitest'
import {
  selectActiveTurn,
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
import { createSource, relaunchedStorage } from '../tests/support'

/**
 * The phone's composer, end to end, against a real environment server and a
 * real Claude Code: pair, connect through the phone's controller, mount the
 * shared application providers on its client as `PhoneEnvironmentProvider`
 * does, open a session through the page's own hook, and drive the composer's
 * own model (`useLiveComposerModel`, the hook `LiveComposer` draws): a send,
 * a photo attached (uploaded on attach) and sent, a permission answered from
 * the composer, and a running turn interrupted. The wire is recorded.
 *
 * LIVE_SERVER     the server's loopback URL, e.g. http://127.0.0.1:43461
 * LIVE_DATA_DIR   the server's data directory (for its owner credential)
 * LIVE_WORKSPACE  a scratch folder for the session (the permission writes a file there)
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
    this.addEventListener('message', (event) => {
      try {
        const message = JSON.parse(String(event.data)) as {
          type: string
          name?: string
          payload?: { record?: { event?: { name?: string } } }
        }
        if (message.type === 'event' && message.name) {
          const name = message.payload?.record?.event?.name ?? message.name
          frames.push({ direction: 'in', name, t: Date.now() - started })
        }
      } catch {
        /* not JSON */
      }
    })
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

/** A 16×16 PNG of one colour, built here so the check needs no file. */
function solidPng(r: number, g: number, b: number): string {
  const size = 16
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(data.length, 0)
    head.write(type, 4, 'ascii')
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])) >>> 0, 0)
    return Buffer.concat([head, data, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array(size).fill([r, g, b]).flat())])
  const raw = Buffer.concat(Array(size).fill(row))
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
  return `data:image/png;base64,${png.toString('base64')}`
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

describe('the phone composer, live', () => {
  it('sends, attaches a photo, answers a permission and interrupts a turn', async () => {
    const dom = await installDom()
    const { act } = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { EnvironmentApplicationProviders, EnvironmentClientProvider } =
      await import('@openmanager/app-core/logic')
    const { createPhoneConnectionController } = await import('../src/environment/controller')
    const { useReadOnlySession } = await import('../src/session/useReadOnlySession')
    const { useLiveComposerModel } = await import('../src/composer/useLiveComposerModel')
    const { ThreadBridge } = await import('../src/composer/thread-port')

    // ---- the owner, as web: a scratch project and a Claude session -------
    const ownerCredential = readFileSync(join(DATA_DIR, 'owner-credential'), 'utf8').trim()
    const owner = createWebSocketEnvironmentClient({
      url: `${SERVER.replace('http:', 'ws:')}/ws`,
      credential: ownerCredential,
      WebSocket: NodeWebSocket as unknown as WebSocketConstructor,
    })
    cleanups.push(() => owner.dispose())
    owner.connect()
    await until('owner connected', () => owner.getState().connection.phase === 'connected')
    const environmentId = owner.getState().environment!.environmentId
    const workspace = await owner.commands.addWorkspace({ path: WORKSPACE_PATH })
    const created = await owner.commands.createSession({
      environmentId,
      workspaceId: workspace.workspaceId,
      providerId: 'claude',
      title: 'Composer live check',
    })
    const sessionId = created.session.sessionId
    note('session.created', { by: 'owner', sessionId, workspace: workspace.path })

    const { token } = await owner.commands.createPairingLink({
      capabilities: ['read', 'operate', 'agent'],
      label: 'Composer live check',
    })
    const paired = await exchangePairingToken(SERVER, { token, label: 'Composer live check' })

    // ---- the phone's controller and the shared providers ----------------
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
    let phase = ''
    function Page() {
      const view = useReadOnlySession(sessionId)
      const composer = useLiveComposerModel(sessionId)
      phase = view.phase
      model = composer.model
      return createElement(ThreadBridge, { port: composer.port })
    }
    const root = createRoot(dom.window.document.getElementById('root')!)
    await act(() =>
      root.render(
        createElement(EnvironmentClientProvider, {
          client,
          children: createElement(EnvironmentApplicationProviders, {
            storage: null,
            navigateDraft: async () => undefined,
            children: createElement(Page),
          }),
        }),
      ),
    )
    cleanups.push(() => root.unmount())
    const now = () => model as ComposerModel | null
    const tick = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 50)))
    const wait = async (label: string, read: (m: ComposerModel) => boolean, ms = 120_000) => {
      await until(label, () => !!now() && read(now()!), ms)
      await tick()
    }
    const replies = () =>
      Object.values(client.getState().threads).flatMap((thread) =>
        thread.messages.filter((message) => message.role === 'assistant'),
      ).length
    const sessionStatus = () => client.getState().sessions[sessionId]?.status
    await until('page ready', () => phase === 'ready', 60_000)
    await wait('picks', (m) => m.picks.providerId === 'claude')
    note('picks', { ...now()!.picks, modes: now()!.modeChoices.map((mode) => mode.id) })
    if (now()!.picks.mode?.id !== 'default') {
      await act(async () => now()!.pickMode('default'))
      await wait('default mode', (m) => m.picks.mode?.id === 'default', 30_000)
    }

    // ---- 1. send --------------------------------------------------------
    let since = Date.now() - started
    let before = replies()
    await act(async () => now()!.setText('Reply with exactly the word pong.'))
    await wait('send enabled', (m) => m.primary.kind === 'send' && m.primary.enabled)
    await act(async () => now()!.send())
    await wait('turn running', (m) => m.isStreaming, 60_000)
    await wait(
      'turn done',
      (m) => !m.isStreaming && replies() > before && sessionStatus() !== 'running',
      180_000,
    )
    note('send', { sent: sentSince(since), text: now()!.text, status: sessionStatus() })
    expect(sentSince(since)).toContain('turn.send')

    // ---- 2. a photo, uploaded on attach, then sent ----------------------
    since = Date.now() - started
    before = replies()
    await act(async () =>
      now()!.attachPhoto({ uri: solidPng(220, 30, 30), name: 'red.png', mimeType: 'image/png' }),
    )
    await wait('photo kept', (m) => m.images.length === 1 && !m.images[0]!.uploading, 60_000)
    note('photo.kept', { image: { ...now()!.images[0], uri: undefined }, sent: sentSince(since) })
    expect(sentSince(since)).toContain('upload.ticket.create')
    await act(async () => now()!.setText('What colour is this image? Answer in one word.'))
    await wait('send enabled', (m) => m.primary.enabled)
    await act(async () => now()!.send())
    await wait(
      'image turn done',
      (m) => !m.isStreaming && replies() > before && sessionStatus() !== 'running',
      180_000,
    )
    const lastReply = Object.values(client.getState().threads)
      .flatMap((thread) => thread.messages)
      .filter((message) => message.role === 'assistant')
      .at(-1)
    const replyText = (lastReply?.content ?? [])
      .map((part) => ('text' in part && typeof part.text === 'string' ? part.text : ''))
      .join(' ')
    note('photo.sent', { sent: sentSince(since), images: now()!.images.length, reply: replyText })
    // Claude saw the photo: it names its colour.
    expect(replyText).toMatch(/red/i)
    expect(now()!.images).toEqual([])

    // ---- 3. a permission, answered from the composer --------------------
    since = Date.now() - started
    before = replies()
    const target = join(WORKSPACE_PATH, 'phone-permission.txt')
    // A fresh file, so only this turn's write can satisfy the check.
    rmSync(target, { force: true })
    const askedAt = Date.now()
    await act(async () =>
      now()!.setText(
        'Use the Write tool to create a file named phone-permission.txt in the current folder containing the single word hello. Do nothing else.',
      ),
    )
    await act(async () => now()!.send())
    await wait('permission prompt', (m) => m.prompt?.kind === 'permission', 180_000)
    const prompt = now()!.prompt
    if (prompt?.kind !== 'permission') throw new Error('no permission')
    note('permission.prompt', {
      title: prompt.title,
      detail: prompt.detail,
      choices: prompt.choices,
    })
    const allow = prompt.choices.find((choice) => choice.tone === 'primary') ?? prompt.choices[0]!
    await act(async () => prompt.answer(allow.optionId))
    await wait('permission gone', (m) => m.prompt === null, 60_000)
    await wait(
      'permission turn done',
      (m) => !m.isStreaming && replies() > before && sessionStatus() !== 'running',
      180_000,
    )
    note('permission.answered', {
      choice: allow,
      sent: sentSince(since),
      fileWritten: existsSync(target),
      content: existsSync(target) ? readFileSync(target, 'utf8') : null,
    })
    expect(sentSince(since)).toContain('interaction.respond')
    expect(allow.label).toMatch(/allow/i)
    expect(existsSync(target)).toBe(true)
    expect(readFileSync(target, 'utf8').trim()).toBe('hello')
    expect(statSync(target).mtimeMs).toBeGreaterThanOrEqual(askedAt - 1_000)

    // ---- 4. interrupt a running turn ------------------------------------
    since = Date.now() - started
    await act(async () =>
      now()!.setText('Count from 1 to 300 in words, one number per line. Use no tools.'),
    )
    await act(async () => now()!.send())
    await wait(
      'stop offered',
      (m) => m.isStreaming && m.primary.kind === 'stop' && m.primary.enabled,
      120_000,
    )
    await new Promise((resolve) => setTimeout(resolve, 2_000))
    // The turn the button will stop: the one running now.
    const targeted = selectActiveTurn(client.getState())?.turnId
    expect(targeted).toBeTruthy()
    await act(async () => now()!.interrupt())
    await wait('stopped', (m) => !m.isStreaming, 60_000)
    const interrupted = Object.values(client.getState().threads)
      .flatMap((thread) => thread.turns)
      .find((turn) => turn.turnId === targeted)
    note('interrupt', {
      sent: sentSince(since),
      turnId: targeted,
      turn: interrupted?.state,
      primary: now()!.primary,
    })
    expect(sentSince(since)).toContain('turn.interrupt')
    expect(interrupted?.state).toBe('interrupted')
    expect(sentSince(0)).not.toContain('session.history')
  })
})
