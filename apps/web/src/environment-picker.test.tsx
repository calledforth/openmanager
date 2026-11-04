import { DRAFT_SAVE_MAX_BYTES, PROTOCOL_VERSION } from '@openmanager/protocol'
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createMockEnvironmentClient,
  selectDraftContent,
  selectDraftTarget,
  selectNewSessionDraftIds,
  WIRE_COMMANDS,
  type EnvironmentCommandName,
  type MockSeed,
  type WebSocketEnvironmentClientOptions,
} from '@openmanager/environment-client'
import { ENVIRONMENT_STORAGE_KEY } from '@openmanager/environment-client/connection'
import {
  DRAFT_HANDOVER_WINDOW_MS,
  DRAFT_HANDOVERS_KEY,
  type DraftHandover,
} from './lib/draft-handovers'
import { idleUntilDialled, renderWebApp } from './test-utils'

const DESK = 'http://127.0.0.1:43120'
const LAPTOP = 'http://127.0.0.1:43121'

afterEach(() => {
  fireEvent.pointerMove(window, { clientX: 999, clientY: 999 })
  cleanup()
  localStorage.clear()
  vi.unstubAllGlobals()
})

function seedRegistry({
  selectedId = 'env-desk',
  only = false,
}: { selectedId?: string; only?: boolean } = {}) {
  localStorage.setItem(
    ENVIRONMENT_STORAGE_KEY,
    JSON.stringify({
      version: 1,
      selectedId,
      environments: [
        { environmentId: 'env-desk', label: 'Desk', endpoints: [DESK], credential: '' },
        ...(only
          ? []
          : [
              { environmentId: 'env-laptop', label: 'Laptop', endpoints: [LAPTOP], credential: '' },
            ]),
      ],
    }),
  )
}

function answering({ laptop = true }: { laptop?: boolean } = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const onLaptop = String(input).startsWith(LAPTOP)
      if (onLaptop && !laptop) throw new TypeError('Failed to fetch')
      return {
        ok: true,
        status: 200,
        json: async () => ({
          protocolVersion: PROTOCOL_VERSION,
          capabilities: ['connection.heartbeat'],
          environmentId: onLaptop ? 'env-laptop' : 'env-desk',
          label: onLaptop ? 'Laptop' : 'Desk',
        }),
      }
    }),
  )
}

function project(name: string, lastActivityAt: string | null = null) {
  return {
    workspaceId: `/${name}`,
    name,
    path: `/${name}`,
    lastUsedAt: null,
    lastActivityAt,
    exists: true,
    capabilities: { git: false },
  }
}

type Mock = ReturnType<typeof createMockEnvironmentClient>

const clientWith = (
  environmentId: string,
  workspaces: MockSeed['workspaces'],
  latencyMs?: number,
  capabilities?: readonly EnvironmentCommandName[],
) =>
  createMockEnvironmentClient({
    seed: { environment: { environmentId, name: environmentId }, workspaces },
    ...(latencyMs ? { latencyMs } : {}),
    ...(capabilities ? { capabilities } : {}),
  })

const deskClient = () => clientWith('env-desk', [project('desk-project')])
const laptopClient = (latencyMs?: number) =>
  clientWith(
    'env-laptop',
    [
      project('laptop-old', '2026-01-01T00:00:00.000Z'),
      project('laptop-recent', '2026-06-01T00:00:00.000Z'),
    ],
    latencyMs,
  )

function renderBoth(path: string, { desk, laptop }: { desk: Mock; laptop: Mock }) {
  const create = (options: WebSocketEnvironmentClientOptions) =>
    idleUntilDialled(options.environmentId === 'env-laptop' ? laptop : desk)
  return renderWebApp(path, { createEnvironmentClient: create as never })
}

const selected = () =>
  (JSON.parse(localStorage.getItem(ENVIRONMENT_STORAGE_KEY)!) as { selectedId: string }).selectedId

const picker = () => screen.findByRole('button', { name: /^Environment: / })
const projectPicker = () => screen.findByRole('button', { name: /^Project: / })
const commandsOf = (client: Mock, command: string) =>
  client.calls.filter((call) => call.command === command)

async function connected(...clients: Mock[]) {
  for (const client of clients) {
    await waitFor(() => expect(client.getState().connection.phase).toBe('connected'))
  }
}

async function pick(user: ReturnType<typeof userEvent.setup>, label: string) {
  await user.click(await picker())
  const menu = await screen.findByRole('dialog', { name: 'Choose an environment' })
  await user.click(within(menu).getByRole('option', { name: new RegExp(`^${label}`) }))
}

describe('the environment picker on the new session page', () => {
  it('is not there with one environment saved', async () => {
    seedRegistry({ only: true })
    answering()
    const desk = deskClient()
    renderBoth('/', { desk, laptop: laptopClient() })

    expect(await projectPicker()).toHaveTextContent('desk-project')
    expect(screen.queryByRole('button', { name: /^Environment: / })).not.toBeInTheDocument()
    expect(screen.getByText('env-desk')).toBeInTheDocument()
  })

  it('starts on the environment last used', async () => {
    seedRegistry({ selectedId: 'env-laptop' })
    answering()
    renderBoth('/', { desk: deskClient(), laptop: laptopClient() })

    expect(await picker()).toHaveTextContent('Laptop')
    expect(await projectPicker()).toHaveTextContent('laptop-recent')
  })

  it("moves to the most recent project there and lists only that environment's", async () => {
    seedRegistry()
    answering()
    const user = userEvent.setup()
    const desk = deskClient()
    const laptop = laptopClient()
    renderBoth('/', { desk, laptop })
    await connected(desk, laptop)
    expect(await projectPicker()).toHaveTextContent('desk-project')

    await pick(user, 'Laptop')

    await waitFor(() => expect(selected()).toBe('env-laptop'))
    expect(await projectPicker()).toHaveTextContent('laptop-recent')
    expect(await picker()).toHaveTextContent('Laptop')
    await user.click(await projectPicker())
    const menu = await screen.findByRole('dialog', { name: 'Choose a project' })
    expect(within(menu).queryByText('desk-project')).not.toBeInTheDocument()
    expect(within(menu).getByText('laptop-old')).toBeInTheDocument()
  })

  it('starts the session on the environment chosen, and names it', async () => {
    seedRegistry()
    answering()
    const user = userEvent.setup()
    const desk = deskClient()
    const laptop = laptopClient()
    renderBoth('/', { desk, laptop })
    await connected(desk, laptop)

    await pick(user, 'Laptop')
    await waitFor(() => expect(selected()).toBe('env-laptop'))
    fireEvent.change(await screen.findByRole('textbox'), {
      target: { value: 'On the laptop, please' },
    })
    await user.click(await screen.findByRole('button', { name: 'Send' }))

    await waitFor(() => expect(commandsOf(laptop, 'createSession')).toHaveLength(1))
    expect(commandsOf(laptop, 'createSession')[0]!.input).toMatchObject({
      environmentId: 'env-laptop',
      workspaceId: '/laptop-recent',
      firstMessage: 'On the laptop, please',
    })
    expect(commandsOf(desk, 'createSession')).toEqual([])
  })

  it('offers an environment it cannot reach, but does not go there', async () => {
    seedRegistry()
    answering({ laptop: false })
    const user = userEvent.setup()
    const desk = deskClient()
    renderBoth('/', { desk, laptop: laptopClient() })
    await connected(desk)

    await user.click(await picker())
    const menu = await screen.findByRole('dialog', { name: 'Choose an environment' })
    const row = within(menu).getByRole('option', { name: /^Laptop/ })
    expect(row).toHaveAttribute('aria-disabled', 'true')
    expect(row).toHaveTextContent('Not connected')
    fireEvent.click(row)
    expect(selected()).toBe('env-desk')
  })

  it('tells apart two environments with one name by their addresses', async () => {
    localStorage.setItem(
      ENVIRONMENT_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        selectedId: 'env-desk',
        environments: [
          { environmentId: 'env-desk', label: 'Clemax', endpoints: [DESK], credential: '' },
          { environmentId: 'env-laptop', label: 'Clemax', endpoints: [LAPTOP], credential: '' },
        ],
      }),
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => ({
        ok: true,
        status: 200,
        json: async () => ({
          protocolVersion: PROTOCOL_VERSION,
          capabilities: ['connection.heartbeat'],
          environmentId: String(input).startsWith(LAPTOP) ? 'env-laptop' : 'env-desk',
          label: 'Clemax',
        }),
      })),
    )
    const user = userEvent.setup()
    renderBoth('/', { desk: deskClient(), laptop: laptopClient() })

    await user.click(await picker())
    const menu = await screen.findByRole('dialog', { name: 'Choose an environment' })
    expect(within(menu).getByText('127.0.0.1:43120')).toBeInTheDocument()
    expect(within(menu).getByText('127.0.0.1:43121')).toBeInTheDocument()
  })

  it('adds a project to the environment chosen', async () => {
    seedRegistry()
    answering()
    const user = userEvent.setup()
    const desk = deskClient()
    const laptop = laptopClient()
    // The typed path, rather than the folder browser, is the shorter way there.
    const { supports } = laptop
    laptop.supports = (command) => command !== 'browseFolders' && supports(command)
    renderBoth('/', { desk, laptop })
    await connected(desk, laptop)

    await pick(user, 'Laptop')
    await waitFor(() => expect(selected()).toBe('env-laptop'))
    await user.click(await projectPicker())
    const menu = await screen.findByRole('dialog', { name: 'Choose a project' })
    await user.click(within(menu).getByRole('option', { name: /Add project/ }))
    fireEvent.change(await screen.findByRole('textbox', { name: 'Folder path' }), {
      target: { value: '/laptop-new' },
    })
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Add project' }),
    )

    await waitFor(() => expect(commandsOf(laptop, 'addWorkspace')).toHaveLength(1))
    expect(commandsOf(desk, 'addWorkspace')).toEqual([])
  })

  it('gives way to the chat once a session is starting from the page', async () => {
    seedRegistry()
    answering()
    const user = userEvent.setup()
    const desk = deskClient()
    const laptop = laptopClient()
    vi.spyOn(desk.commands, 'createSession').mockReturnValue(new Promise(() => undefined))
    renderBoth('/', { desk, laptop })
    await connected(desk, laptop)

    fireEvent.change(await screen.findByRole('textbox'), { target: { value: 'Going now' } })
    await user.click(await screen.findByRole('button', { name: 'Send' }))

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /^Environment: / })).not.toBeInTheDocument(),
    )
  })
})

describe('a draft that changes environment', () => {
  const edit = (client: Mock, content: { text: string; artifactIds?: string[] }) =>
    client.commands.saveDraft({
      draftId: 'desk-draft',
      baseRevision: 0,
      target: { type: 'new_session', sessionId: 'desk-next', workspaceId: '/desk-project' },
      content,
    })
  const cardsWith = (text: string) =>
    screen.queryAllByRole('button').filter((button) => button.textContent?.includes(text))
  const settleFor = (ms: number) =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms))
    })

  it('keeps its text, and the old one goes only once the copy is saved', async () => {
    seedRegistry()
    answering()
    const user = userEvent.setup()
    const desk = deskClient()
    const laptop = laptopClient()
    await edit(desk, { text: 'Bring this along' })
    const deletes: Array<{ copySaved: boolean }> = []
    // Whether the copy was saved on the laptop when the desk let go of the original.
    desk.subscribe(() => {
      if (deletes.length > 0 || desk.getState().drafts['desk-draft']) return
      const [copy] = selectNewSessionDraftIds(laptop.getState())
      deletes.push({
        copySaved: copy !== undefined && laptop.getState().drafts[copy] !== undefined,
      })
    })
    const { router } = renderBoth('/drafts/desk-draft', { desk, laptop })
    await connected(desk, laptop)
    expect(await screen.findByDisplayValue('Bring this along')).toBeInTheDocument()

    await pick(user, 'Laptop')

    await waitFor(() => expect(selected()).toBe('env-laptop'))
    expect(await screen.findByDisplayValue('Bring this along')).toBeInTheDocument()
    expect(await projectPicker()).toHaveTextContent('laptop-recent')
    const [moved] = selectNewSessionDraftIds(laptop.getState())
    expect(selectDraftTarget(laptop.getState(), moved!)).toMatchObject({
      type: 'new_session',
      workspaceId: '/laptop-recent',
    })
    expect(selectDraftContent(laptop.getState(), moved!)).toEqual({ text: 'Bring this along' })
    expect(router.state.location.pathname).toBe(`/drafts/${moved}`)
    await waitFor(() => expect(desk.getState().drafts['desk-draft']).toBeUndefined())
    expect(deletes).toEqual([{ copySaved: true }])
    await waitFor(() => expect(cardsWith('Bring this along')).toHaveLength(1))
  })

  it('keeps the old draft until the copy is saved where it went', async () => {
    seedRegistry()
    answering()
    const user = userEvent.setup()
    const desk = deskClient()
    // Every answer from the laptop takes a while, its draft saves included.
    const laptop = laptopClient(1500)
    await edit(desk, { text: 'Not yet safe' })
    renderBoth('/drafts/desk-draft', { desk, laptop })
    await connected(desk, laptop)
    await screen.findByDisplayValue('Not yet safe')

    await pick(user, 'Laptop')
    await waitFor(() => expect(selected()).toBe('env-laptop'))
    await settleFor(400)
    const [copy] = selectNewSessionDraftIds(laptop.getState())
    expect(laptop.getState().drafts[copy!]).toBeUndefined()
    expect(desk.getState().drafts['desk-draft']?.content.text).toBe('Not yet safe')

    await waitFor(() => expect(laptop.getState().drafts[copy!]).toBeDefined(), { timeout: 6000 })
    await waitFor(() => expect(desk.getState().drafts['desk-draft']).toBeUndefined())
  })

  it('keeps the old draft when another device wrote to it meanwhile', async () => {
    seedRegistry()
    answering()
    const user = userEvent.setup()
    const desk = deskClient()
    const laptop = laptopClient(1500)
    const first = await edit(desk, { text: 'Typed here' })
    renderBoth('/drafts/desk-draft', { desk, laptop })
    await connected(desk, laptop)
    await screen.findByDisplayValue('Typed here')

    await pick(user, 'Laptop')
    await waitFor(() => expect(selected()).toBe('env-laptop'))
    // Another device, straight to the desk.
    await act(() =>
      desk.commands.saveDraft({
        draftId: 'desk-draft',
        baseRevision: first.revision,
        target: { type: 'new_session', sessionId: 'desk-next', workspaceId: '/desk-project' },
        content: { text: 'Typed on the phone' },
      }),
    )
    const [copy] = selectNewSessionDraftIds(laptop.getState())
    await waitFor(() => expect(laptop.getState().drafts[copy!]).toBeDefined(), { timeout: 6000 })
    await settleFor(300)

    expect(desk.getState().drafts['desk-draft']?.content.text).toBe('Typed on the phone')
  })

  it('leaves a draft with images where it is, and says so', async () => {
    seedRegistry()
    answering()
    const user = userEvent.setup()
    const desk = deskClient()
    const laptop = laptopClient()
    await edit(desk, { text: 'With a picture', artifactIds: ['image-1'] })
    renderBoth('/drafts/desk-draft', { desk, laptop })
    await connected(desk, laptop)
    await screen.findByDisplayValue('With a picture')

    await pick(user, 'Laptop')

    expect(await screen.findByText('Its images stayed with the draft on Desk')).toBeInTheDocument()
    expect(await screen.findByDisplayValue('With a picture')).toBeInTheDocument()
    const [moved] = selectNewSessionDraftIds(laptop.getState())
    expect(selectDraftContent(laptop.getState(), moved!)).toEqual({ text: 'With a picture' })
    // Dismissed, then long past any window: nothing was asked to go.
    await user.click(screen.getByRole('button', { name: 'Dismiss' }))
    await settleFor(1500)
    expect(desk.getState().drafts['desk-draft']?.content.artifactIds).toEqual(['image-1'])
    expect(commandsOf(desk, 'deleteDraft')).toEqual([])
    expect(cardsWith('With a picture').length).toBeGreaterThan(0)
  })

  it('discards the one left behind only when asked, with the usual undo', async () => {
    seedRegistry()
    answering()
    const user = userEvent.setup()
    const desk = deskClient()
    const laptop = laptopClient()
    await edit(desk, { text: 'With a picture', artifactIds: ['image-1'] })
    renderBoth('/drafts/desk-draft', { desk, laptop })
    await connected(desk, laptop)
    await screen.findByDisplayValue('With a picture')

    await pick(user, 'Laptop')
    await user.click(await screen.findByRole('button', { name: 'Discard it on Desk' }))

    expect(await screen.findByText('Draft discarded')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Undo' }))
    await settleFor(300)
    expect(desk.getState().drafts['desk-draft']?.content.artifactIds).toEqual(['image-1'])
  })

  it('moves nothing of a draft that is only images, and deletes nothing', async () => {
    seedRegistry()
    answering()
    const user = userEvent.setup()
    const desk = deskClient()
    const laptop = laptopClient()
    await edit(desk, { text: '', artifactIds: ['image-1'] })
    const { router } = renderBoth('/drafts/desk-draft', { desk, laptop })
    await connected(desk, laptop)
    await projectPicker()

    await pick(user, 'Laptop')

    await waitFor(() => expect(selected()).toBe('env-laptop'))
    expect(await screen.findByText('The draft and its images stayed on Desk')).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/')
    expect(selectNewSessionDraftIds(laptop.getState())).toEqual([])
    await settleFor(500)
    expect(desk.getState().drafts['desk-draft']?.content.artifactIds).toEqual(['image-1'])
    expect(commandsOf(desk, 'deleteDraft')).toEqual([])
  })

  it('keeps the old draft when it is written to here while the copy saves', async () => {
    seedRegistry()
    answering()
    const user = userEvent.setup()
    const desk = deskClient()
    const laptop = laptopClient(1500)
    await edit(desk, { text: 'First paragraph' })
    renderBoth('/drafts/desk-draft', { desk, laptop })
    await connected(desk, laptop)
    await screen.findByDisplayValue('First paragraph')

    await pick(user, 'Laptop')
    await waitFor(() => expect(selected()).toBe('env-laptop'))
    // Back on the original on this device, before the laptop has the copy.
    const target = desk.getState().drafts['desk-draft']!.target
    act(() => desk.drafts!.edit('desk-draft', target, { text: 'First paragraph\n\nAnd a second' }))
    const [copy] = selectNewSessionDraftIds(laptop.getState())
    await waitFor(() => expect(laptop.getState().drafts[copy!]).toBeDefined(), { timeout: 6000 })
    await settleFor(1500)

    expect(desk.getState().drafts['desk-draft']?.content.text).toBe(
      'First paragraph\n\nAnd a second',
    )
  })

  it('counts an image still on its way in, and deletes nothing', async () => {
    seedRegistry()
    answering()
    const user = userEvent.setup()
    const desk = deskClient()
    const laptop = laptopClient()
    await edit(desk, { text: 'Picture coming' })
    renderBoth('/drafts/desk-draft', { desk, laptop })
    await connected(desk, laptop)
    await screen.findByDisplayValue('Picture coming')
    // What the composer holds while an attached image uploads.
    const release = desk.drafts!.holdEmpty('desk-draft')

    await pick(user, 'Laptop')

    expect(await screen.findByText('Its images stayed with the draft on Desk')).toBeInTheDocument()
    await settleFor(1500)
    expect(desk.getState().drafts['desk-draft']?.content.text).toBe('Picture coming')
    expect(commandsOf(desk, 'deleteDraft')).toEqual([])
    release()
  })

  it('makes one copy of a draft moved twice', async () => {
    seedRegistry()
    answering()
    const user = userEvent.setup()
    const desk = deskClient()
    const laptop = laptopClient(1500)
    await edit(desk, { text: 'Only once' })
    const { router } = renderBoth('/drafts/desk-draft', { desk, laptop })
    await connected(desk, laptop)
    await screen.findByDisplayValue('Only once')

    await pick(user, 'Laptop')
    await waitFor(() => expect(selected()).toBe('env-laptop'))
    // Back to the original while its copy is still saving, and away again.
    await act(() => router.navigate({ to: '/drafts/$draftId', params: { draftId: 'desk-draft' } }))
    await waitFor(() => expect(selected()).toBe('env-desk'))
    await screen.findByDisplayValue('Only once')
    await pick(user, 'Laptop')
    // Said, rather than nothing happening.
    expect(
      await screen.findByText(
        'This draft is moving to Laptop. The original on Desk goes once the copy is saved',
      ),
    ).toBeInTheDocument()
    expect(selected()).toBe('env-desk')
    await settleFor(300)

    const copies = selectNewSessionDraftIds(laptop.getState()).filter(
      (draftId) => selectDraftContent(laptop.getState(), draftId)?.text === 'Only once',
    )
    expect(copies).toHaveLength(1)
  })

  const refusingLaptop = () =>
    // A project id the environment's drafts refuse, standing in for any refusal.
    clientWith('env-laptop', [project('laptop project', '2026-06-01T00:00:00.000Z')])
  const handoverRecord = (overrides: Partial<DraftHandover> = {}): DraftHandover => ({
    environmentId: 'env-laptop',
    copy: { draftId: 'laptop-copy', sessionId: 'laptop-copy-session' },
    arrival: '/drafts/laptop-copy',
    left: {
      draftId: 'desk-draft',
      environmentId: 'env-desk',
      revision: 1,
      text: 'Left behind',
      images: 0,
    },
    createdAt: Date.now(),
    ...overrides,
  })
  const keep = (...handovers: DraftHandover[]) =>
    localStorage.setItem(DRAFT_HANDOVERS_KEY, JSON.stringify({ version: 1, handovers }))
  const kept = () =>
    (
      JSON.parse(localStorage.getItem(DRAFT_HANDOVERS_KEY) ?? '{"handovers":[]}') as {
        handovers: DraftHandover[]
      }
    ).handovers
  it('finishes a choice the user moved on from, as asked', async () => {
    seedRegistry()
    answering()
    const user = userEvent.setup()
    const desk = deskClient()
    const laptop = laptopClient()
    await edit(desk, { text: 'Moved on' })
    const { router } = renderBoth('/drafts/desk-draft', { desk, laptop })
    await connected(desk, laptop)
    await screen.findByDisplayValue('Moved on')

    await user.click(await picker())
    const menu = await screen.findByRole('dialog', { name: 'Choose an environment' })
    // Settings, in the same moment as the choice, before its page arrives.
    await act(async () => {
      fireEvent.click(within(menu).getByRole('option', { name: /^Laptop/ }))
      void router.navigate({ to: '/settings' })
    })
    await waitFor(() => expect(router.state.location.pathname).toBe('/settings'))

    // The copy stays, and the original goes once the copy is saved.
    await waitFor(() => expect(desk.getState().drafts['desk-draft']).toBeUndefined(), {
      timeout: 3000,
    })
    const copies = selectNewSessionDraftIds(laptop.getState()).filter(
      (draftId) => selectDraftContent(laptop.getState(), draftId)?.text === 'Moved on',
    )
    expect(copies).toHaveLength(1)
    expect(laptop.getState().drafts[copies[0]!]).toBeDefined()
    expect(commandsOf(laptop, 'deleteDraft')).toEqual([])
  })

  it('takes the user back to the original when the copy is refused there', async () => {
    seedRegistry()
    answering()
    const user = userEvent.setup()
    const desk = deskClient()
    const laptop = refusingLaptop()
    await edit(desk, { text: 'Turned away' })
    const { router } = renderBoth('/drafts/desk-draft', { desk, laptop })
    await connected(desk, laptop)
    await screen.findByDisplayValue('Turned away')

    await pick(user, 'Laptop')

    expect(
      await screen.findByText("Laptop couldn't save the copy. The draft is still on Desk"),
    ).toBeInTheDocument()
    await waitFor(() => expect(router.state.location.pathname).toBe('/drafts/desk-draft'))
    await waitFor(() => expect(selected()).toBe('env-desk'))
    expect(await screen.findByDisplayValue('Turned away')).toBeInTheDocument()
    expect(desk.getState().drafts['desk-draft']?.content.text).toBe('Turned away')
    expect(commandsOf(desk, 'deleteDraft')).toEqual([])
  })

  it('offers the original when a copy is refused after the user moved on', async () => {
    seedRegistry()
    answering()
    const user = userEvent.setup()
    const desk = deskClient()
    const laptop = refusingLaptop()
    await edit(desk, { text: 'Turned away' })
    const { router } = renderBoth('/drafts/desk-draft', { desk, laptop })
    await connected(desk, laptop)
    await screen.findByDisplayValue('Turned away')

    await user.click(await picker())
    const menu = await screen.findByRole('dialog', { name: 'Choose an environment' })
    await act(async () => {
      fireEvent.click(within(menu).getByRole('option', { name: /^Laptop/ }))
      void router.navigate({ to: '/settings' })
    })

    expect(
      await screen.findByText("Laptop couldn't save the copy. The draft is still on Desk"),
    ).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/settings')
    await user.click(screen.getByRole('button', { name: 'Open' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/drafts/desk-draft'))
    expect(await screen.findByDisplayValue('Turned away')).toBeInTheDocument()
    expect(commandsOf(desk, 'deleteDraft')).toEqual([])
  })

  it('leaves the draft where it is when the environment chosen keeps no drafts', async () => {
    seedRegistry()
    answering()
    const user = userEvent.setup()
    const desk = deskClient()
    const laptop = clientWith(
      'env-laptop',
      [project('laptop-recent')],
      undefined,
      (Object.keys(WIRE_COMMANDS) as EnvironmentCommandName[]).filter(
        (command) => command !== 'saveDraft',
      ),
    )
    await edit(desk, { text: 'Nowhere to keep it' })
    const { router } = renderBoth('/drafts/desk-draft', { desk, laptop })
    await connected(desk, laptop)
    await screen.findByDisplayValue('Nowhere to keep it')

    await pick(user, 'Laptop')

    expect(
      await screen.findByText("Laptop doesn't keep drafts, so this one stayed on Desk"),
    ).toBeInTheDocument()
    expect(selected()).toBe('env-laptop')
    // Nothing copied there, and nothing gone here.
    expect(Object.keys(laptop.getState().draftEdits)).toEqual([])
    await settleFor(500)
    expect(desk.getState().drafts['desk-draft']?.content.text).toBe('Nowhere to keep it')
    expect(commandsOf(desk, 'deleteDraft')).toEqual([])
    await user.click(screen.getByRole('button', { name: 'Open it' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/drafts/desk-draft'))
    expect(await screen.findByDisplayValue('Nowhere to keep it')).toBeInTheDocument()
  })

  it('says so, and keeps both, when the draft is too long to save there', async () => {
    seedRegistry()
    answering()
    const user = userEvent.setup()
    const desk = deskClient()
    const laptop = laptopClient()
    // Over what one save may carry, though under the longest text a draft may hold.
    const long = 'x'.repeat(DRAFT_SAVE_MAX_BYTES + 1_000)
    await edit(desk, { text: long })
    renderBoth('/drafts/desk-draft', { desk, laptop })
    await connected(desk, laptop)
    await projectPicker()

    await pick(user, 'Laptop')

    expect(
      await screen.findByText(
        'This draft is too long to save on Laptop. The original on Desk was kept',
      ),
    ).toBeInTheDocument()
    await settleFor(500)
    expect(desk.getState().drafts['desk-draft']?.content.text).toBe(long)
    expect(commandsOf(desk, 'deleteDraft')).toEqual([])
    expect(commandsOf(laptop, 'saveDraft')).toEqual([])
  })

  it.each([
    ['on the copy', true],
    ['somewhere else', false],
  ])('finishes a move cut short by a reload, loading again %s', async (_where, onCopy) => {
    seedRegistry()
    answering()
    const user = userEvent.setup()
    const desk = deskClient()
    // Slow enough that the page goes before the copy is saved.
    const laptop = laptopClient(1500)
    await edit(desk, { text: 'Across a reload' })
    renderBoth('/drafts/desk-draft', { desk, laptop })
    await connected(desk, laptop)
    await screen.findByDisplayValue('Across a reload')
    await pick(user, 'Laptop')
    // Kept from the moment of the choice.
    expect(kept()).toHaveLength(1)
    const [handover] = kept()
    const copyTarget = selectDraftTarget(laptop.getState(), handover!.copy.draftId)!
    expect(laptop.getState().drafts[handover!.copy.draftId]).toBeUndefined()
    // The tab goes before the laptop answers.
    cleanup()

    // The page loads again: each environment as it stands, the copy still
    // waiting in this browser's cache.
    const deskAgain = deskClient()
    await edit(deskAgain, { text: 'Across a reload' })
    const laptopAgain = laptopClient()
    laptopAgain.drafts!.edit(handover!.copy.draftId, copyTarget, { text: 'Across a reload' })
    renderBoth(onCopy ? handover!.arrival : '/', { desk: deskAgain, laptop: laptopAgain })
    await connected(deskAgain, laptopAgain)

    await waitFor(() => expect(laptopAgain.getState().drafts[handover!.copy.draftId]).toBeDefined())
    await waitFor(() => expect(deskAgain.getState().drafts['desk-draft']).toBeUndefined())
    await waitFor(() => expect(localStorage.getItem(DRAFT_HANDOVERS_KEY)).toBeNull())
  })

  it('keeps the original when the copy is deleted on another device first', async () => {
    seedRegistry()
    answering()
    const user = userEvent.setup()
    const desk = deskClient()
    const laptop = laptopClient(1500)
    await edit(desk, { text: 'Deleted elsewhere' })
    renderBoth('/drafts/desk-draft', { desk, laptop })
    await connected(desk, laptop)
    await screen.findByDisplayValue('Deleted elsewhere')
    await pick(user, 'Laptop')
    const [handover] = kept()
    const copy = handover!.copy.draftId
    // The desk drops before the copy is saved, so the original waits on it.
    act(() => desk.setConnection({ phase: 'reconnecting' }))
    await waitFor(() => expect(laptop.getState().drafts[copy]).toBeDefined(), { timeout: 6000 })

    // The copy is deleted on another device, and its tombstone reaches the laptop.
    await act(() =>
      laptop.commands.deleteDraft({
        draftId: copy,
        baseRevision: laptop.getState().drafts[copy]!.revision,
      }),
    )
    expect(laptop.getState().draftTombstones[copy]).toBeDefined()
    act(() => desk.setConnection({ phase: 'connected' }))
    await settleFor(500)

    expect(desk.getState().drafts['desk-draft']?.content.text).toBe('Deleted elsewhere')
    expect(commandsOf(desk, 'deleteDraft')).toEqual([])
    expect(kept()).toEqual([])
  })

  it('waits out a reconnect until the environment it went to has caught up', async () => {
    seedRegistry()
    answering()
    const user = userEvent.setup()
    const desk = deskClient()
    const laptop = laptopClient(1500)
    await edit(desk, { text: 'Through a reconnect' })
    renderBoth('/drafts/desk-draft', { desk, laptop })
    await connected(desk, laptop)
    await screen.findByDisplayValue('Through a reconnect')
    await pick(user, 'Laptop')
    const [handover] = kept()
    const copy = handover!.copy.draftId
    // The desk drops before the copy is saved, so the original waits on it.
    act(() => desk.setConnection({ phase: 'reconnecting' }))
    await waitFor(() => expect(laptop.getState().drafts[copy]).toBeDefined(), { timeout: 6000 })

    // Now the laptop drops, the desk comes back, and the laptop's handshake
    // lands: connected, with what changed while it was away still to come.
    act(() => laptop.setConnection({ phase: 'reconnecting' }))
    act(() => desk.setConnection({ phase: 'connected' }))
    act(() => laptop.setConnection({ phase: 'connected', caughtUp: false }))
    await settleFor(500)
    expect(desk.getState().drafts['desk-draft']?.content.text).toBe('Through a reconnect')

    // The catch-up: the copy was deleted on another device meanwhile.
    await act(() =>
      laptop.commands.deleteDraft({
        draftId: copy,
        baseRevision: laptop.getState().drafts[copy]!.revision,
      }),
    )
    act(() => laptop.setConnection({ caughtUp: true }))
    await settleFor(500)

    expect(desk.getState().drafts['desk-draft']?.content.text).toBe('Through a reconnect')
    expect(commandsOf(desk, 'deleteDraft')).toEqual([])
    expect(kept()).toEqual([])
  })

  it('asks before discarding the original once the move is past its window', async () => {
    seedRegistry()
    answering()
    const user = userEvent.setup()
    const desk = deskClient()
    const laptop = laptopClient(1500)
    await edit(desk, { text: 'Much later' })
    renderBoth('/drafts/desk-draft', { desk, laptop })
    await connected(desk, laptop)
    await screen.findByDisplayValue('Much later')
    await pick(user, 'Laptop')
    const [handover] = kept()
    const copy = handover!.copy.draftId
    // The copy lands long after the choice.
    const later = Date.now() + DRAFT_HANDOVER_WINDOW_MS + 60_000
    const clock = vi.spyOn(Date, 'now').mockReturnValue(later)
    try {
      await waitFor(() => expect(laptop.getState().drafts[copy]).toBeDefined(), { timeout: 6000 })
      expect(
        await screen.findByText('The copy on Laptop is saved. Discard the original on Desk?'),
      ).toBeInTheDocument()
      await settleFor(300)
      // Both stay until the user says.
      expect(desk.getState().drafts['desk-draft']?.content.text).toBe('Much later')
      expect(commandsOf(desk, 'deleteDraft')).toEqual([])

      await user.click(screen.getByRole('button', { name: 'Discard' }))
      await waitFor(() => expect(desk.getState().drafts['desk-draft']).toBeUndefined())
      expect(commandsOf(desk, 'deleteDraft')).toHaveLength(1)
      expect(selectDraftContent(laptop.getState(), copy)?.text).toBe('Much later')
      expect(commandsOf(laptop, 'deleteDraft')).toEqual([])
    } finally {
      clock.mockRestore()
    }
  })

  it.each([
    ['past its window', { createdAt: Date.now() - DRAFT_HANDOVER_WINDOW_MS - 60_000 }],
    ['for an environment no longer saved', { environmentId: 'env-gone' }],
  ])('lets go of a move %s, and lets the draft move again', async (_why, stale) => {
    seedRegistry()
    answering()
    const user = userEvent.setup()
    const desk = deskClient()
    await edit(desk, { text: 'Left behind' })
    const laptop = laptopClient()
    // Saved there: a live handover would delete the original now.
    await laptop.commands.saveDraft({
      draftId: 'laptop-copy',
      baseRevision: 0,
      target: { type: 'new_session', sessionId: 'laptop-copy-session', workspaceId: '/laptop-old' },
      content: { text: 'Left behind' },
    })
    keep(handoverRecord(stale))
    renderBoth('/drafts/desk-draft', { desk, laptop })
    await connected(desk, laptop)
    await screen.findByDisplayValue('Left behind')

    await waitFor(() => expect(localStorage.getItem(DRAFT_HANDOVERS_KEY)).toBeNull())
    await settleFor(500)
    expect(desk.getState().drafts['desk-draft']?.content.text).toBe('Left behind')
    expect(commandsOf(desk, 'deleteDraft')).toEqual([])

    await pick(user, 'Laptop')
    await waitFor(() => expect(selected()).toBe('env-laptop'))
    expect(screen.queryByText(/is moving to/)).not.toBeInTheDocument()
    const copies = selectNewSessionDraftIds(laptop.getState()).filter(
      (draftId) =>
        draftId !== 'laptop-copy' &&
        selectDraftContent(laptop.getState(), draftId)?.text === 'Left behind',
    )
    expect(copies).toHaveLength(1)
  })

  it("moves another environment's draft of the same id while one is on its way", async () => {
    seedRegistry()
    answering()
    const user = userEvent.setup()
    const desk = deskClient()
    const laptop = laptopClient(1500)
    await edit(desk, { text: 'From the desk' })
    // The same id on the laptop: a draft of its own.
    await laptop.commands.saveDraft({
      draftId: 'desk-draft',
      baseRevision: 0,
      target: { type: 'new_session', sessionId: 'laptop-next', workspaceId: '/laptop-old' },
      content: { text: 'From the laptop' },
    })
    const { router } = renderBoth('/drafts/desk-draft', { desk, laptop })
    await connected(desk, laptop)
    await screen.findByDisplayValue('From the desk')
    await pick(user, 'Laptop')
    await waitFor(() => expect(selected()).toBe('env-laptop'))

    await act(() => router.navigate({ to: '/drafts/$draftId', params: { draftId: 'desk-draft' } }))
    expect(await screen.findByDisplayValue('From the laptop')).toBeInTheDocument()
    await pick(user, 'Desk')

    await waitFor(() => expect(selected()).toBe('env-desk'))
    expect(screen.queryByText(/is moving to/)).not.toBeInTheDocument()
    const copies = selectNewSessionDraftIds(desk.getState()).filter(
      (draftId) => selectDraftContent(desk.getState(), draftId)?.text === 'From the laptop',
    )
    expect(copies).toHaveLength(1)
    // And the first move finished: Desk's own draft went once its copy was saved.
    await waitFor(() => expect(desk.getState().drafts['desk-draft']).toBeUndefined(), {
      timeout: 6000,
    })
  })
})

describe('New agent where the open environment has no projects', () => {
  it('goes to the first environment that has one', async () => {
    seedRegistry()
    answering()
    const user = userEvent.setup()
    const desk = clientWith('env-desk', [])
    const laptop = laptopClient()
    renderBoth('/', { desk, laptop })
    await connected(desk, laptop)

    expect(await picker()).toHaveTextContent('Desk')
    const button = await screen.findByRole('button', { name: 'New agent' })
    await waitFor(() => expect(button).toBeEnabled())
    await user.click(button)

    await waitFor(() => expect(selected()).toBe('env-laptop'))
    // The project the sidebar offered, the first one listed there.
    expect(await projectPicker()).toHaveTextContent('laptop-old')
  })

  it('leaves New agent off when nothing connected has a project', async () => {
    seedRegistry()
    answering({ laptop: false })
    const desk = clientWith('env-desk', [])
    renderBoth('/', { desk, laptop: laptopClient() })
    await connected(desk)

    expect(await screen.findByRole('button', { name: 'New agent' })).toBeDisabled()
  })
})
