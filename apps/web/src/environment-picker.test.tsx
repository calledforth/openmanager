import { PROTOCOL_VERSION } from '@openmanager/protocol'
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createMockEnvironmentClient,
  selectDraftContent,
  selectDraftTarget,
  selectNewSessionDraftIds,
  type MockSeed,
  type WebSocketEnvironmentClientOptions,
} from '@openmanager/environment-client'
import { ENVIRONMENT_STORAGE_KEY } from './lib/environment-store'
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
) =>
  createMockEnvironmentClient({
    seed: { environment: { environmentId, name: environmentId }, workspaces },
    ...(latencyMs ? { latencyMs } : {}),
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
    await settleFor(300)

    const copies = selectNewSessionDraftIds(laptop.getState()).filter(
      (draftId) => selectDraftContent(laptop.getState(), draftId)?.text === 'Only once',
    )
    expect(copies).toHaveLength(1)
  })

  it('drops a choice the user moved on from, and leaves its draft be', async () => {
    seedRegistry()
    answering()
    const user = userEvent.setup()
    const desk = deskClient()
    const laptop = laptopClient()
    await edit(desk, { text: 'Changed my mind' })
    const { router } = renderBoth('/drafts/desk-draft', { desk, laptop })
    await connected(desk, laptop)
    await screen.findByDisplayValue('Changed my mind')

    await user.click(await picker())
    const menu = await screen.findByRole('dialog', { name: 'Choose an environment' })
    // Settings, in the same moment as the choice, before its page arrives.
    await act(async () => {
      fireEvent.click(within(menu).getByRole('option', { name: /^Laptop/ }))
      void router.navigate({ to: '/settings' })
    })
    await waitFor(() => expect(router.state.location.pathname).toBe('/settings'))
    await settleFor(1500)

    expect(desk.getState().drafts['desk-draft']?.content.text).toBe('Changed my mind')
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
