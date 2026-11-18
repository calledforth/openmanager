import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FakeClaudeSdk, FakeConnectionFactory } from '@agentpack/runtime/testing'
import {
  SCRATCHPAD_CHANGED_EVENT,
  SCRATCHPAD_MAX_BYTES,
  SCRATCHPAD_PATH,
  ScratchpadChangedEventSchema,
  ScratchpadResponseSchemas,
  type CommandEnvelope,
  type EventEnvelope,
  type Scratchpad,
} from '@openmanager/protocol/node'
import type { AuthenticatedClient } from '../src/authorized-clients.js'
import type { CommandContext } from '../src/command-context.js'
import {
  openEnvironmentSettings,
  type EnvironmentSettingsStore,
} from '../src/environment-settings.js'
import { createScratchpadService, excludeFromGit, scratchpadNote } from '../src/scratchpad.js'
import type { RegisteredWorkspace } from '../src/workspaces.js'
import {
  cleanupProtocolHosts,
  connectProtocol,
  handshake,
  nextNonPing,
  nextResponse,
  startProtocolHost,
  type ProtocolClient,
} from './helpers/protocol-client.js'
import { expectCommand } from './helpers/proof-slice.js'

const directories: string[] = []
const stores: EnvironmentSettingsStore[] = []
const services: ReturnType<typeof createScratchpadService>[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  for (const service of services.splice(0)) service.close()
  for (const store of stores.splice(0)) store.close()
  await cleanupProtocolHosts()
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function tempDir(prefix = 'openmanager-scratchpad-test-') {
  const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  directories.push(directory)
  return directory
}

/** A service over one real project folder, with its settings in a real store. */
async function setup(options: { kind?: 'scratch'; pollMs?: number; git?: boolean } = {}) {
  const dataDir = await tempDir()
  const root = join(dataDir, 'project')
  await mkdir(root)
  if (options.git) await mkdir(join(root, '.git', 'info'), { recursive: true })
  const workspace: RegisteredWorkspace = {
    workspaceId: 'workspace-1',
    name: 'project',
    root,
    lastUsedAt: null,
    availability: 'available',
    ...(options.kind ? { kind: options.kind } : {}),
  }
  const settings = openEnvironmentSettings(dataDir)
  stores.push(settings)
  const follows = new Map<string, Set<string>>()
  const sent: Array<{ clientId: string; event: EventEnvelope }> = []
  // Real time: a change is put down to an agent by comparing the file's
  // modification time with this clock.
  const now = Date.now()
  const service = createScratchpadService({
    workspaces: {
      resolve: (id) => (id === workspace.workspaceId ? workspace : undefined),
      get: (id) => (id === workspace.workspaceId ? workspace : undefined),
      availability: (id) => (id === workspace.workspaceId ? 'available' : 'unknown'),
    },
    sharing: settings,
    sockets: () => ({
      hasFollowers: (topic) => [...follows.values()].some((topics) => topics.has(topic)),
      publishToFollowers: (topic, build) => {
        for (const [clientId, topics] of follows) {
          if (!topics.has(topic)) continue
          sent.push({ clientId, event: build({ clientId } as AuthenticatedClient) })
        }
      },
    }),
    log: () => undefined,
    clock: () => now,
    pollMs: options.pollMs ?? 60_000,
  })
  services.push(service)
  let id = 0
  const context = (clientId: string): CommandContext => ({
    clientId,
    command: 'test',
    follow: (topic) => {
      const topics = follows.get(clientId) ?? new Set<string>()
      topics.add(topic)
      follows.set(clientId, topics)
    },
  })
  const run = (clientId: string, name: string, payload: unknown) =>
    service.dispatch(
      { type: 'command', requestId: `req-${++id}`, name, payload } as CommandEnvelope,
      context(clientId),
    ) as { type: string; payload?: unknown; error?: { code: string } }
  const get = (clientId = 'client-a') => {
    const answer = run(clientId, 'scratchpad.get', { workspaceId: workspace.workspaceId })
    return ScratchpadResponseSchemas['scratchpad.get'].parse(answer).payload.scratchpad
  }
  const save = (content: string, baseVersion: string | null, clientId = 'client-a') =>
    ScratchpadResponseSchemas['scratchpad.save'].parse(
      run(clientId, 'scratchpad.save', {
        workspaceId: workspace.workspaceId,
        content,
        baseVersion,
      }),
    ).payload
  const setSharing = (shareWithAgents: boolean, clientId = 'client-a') =>
    ScratchpadResponseSchemas['scratchpad.sharing.set'].parse(
      run(clientId, 'scratchpad.sharing.set', {
        workspaceId: workspace.workspaceId,
        shareWithAgents,
      }),
    ).payload.scratchpad
  const changes = (clientId: string): Scratchpad[] =>
    sent
      .filter((item) => item.clientId === clientId)
      .map((item) => ScratchpadChangedEventSchema.parse(item.event).payload.scratchpad)
  return {
    service,
    workspace,
    root,
    dataDir,
    file: join(root, SCRATCHPAD_PATH),
    run,
    get,
    save,
    setSharing,
    changes,
    /** A connection closed: it follows nothing any more. */
    disconnect: (clientId: string) => follows.delete(clientId),
    at: () => now,
  }
}

describe('reading and writing the scratchpad', () => {
  it('reads as empty and shared before anyone has written it', async () => {
    const { get, service } = await setup()
    expect(get()).toEqual({
      workspaceId: 'workspace-1',
      exists: false,
      content: '',
      tooLarge: false,
      version: null,
      modifiedAt: null,
      lastEdit: null,
      shareWithAgents: true,
    })
    // Reading it is what asks to hear about it.
    expect(service.watching('workspace-1')).toBe(true)
  })

  it('creates the file on the first save, and says the saver made it', async () => {
    const { get, save, file, changes, at } = await setup()
    get('client-a')
    get('client-b')
    const result = save('# Plan\n', null)
    expect(result.outcome).toBe('saved')
    expect(await readFile(file, 'utf8')).toBe('# Plan\n')
    expect(result.scratchpad).toMatchObject({
      exists: true,
      content: '# Plan\n',
      lastEdit: { by: { kind: 'you' }, at: new Date(at()).toISOString() },
    })
    // Each follower reads the author as it is to them.
    expect(changes('client-a').at(-1)?.lastEdit?.by).toEqual({ kind: 'you' })
    expect(changes('client-b').at(-1)?.lastEdit?.by).toEqual({
      kind: 'client',
      clientId: 'client-a',
    })
    expect(changes('client-b').at(-1)?.content).toBe('# Plan\n')
  })

  it('makes no file for an empty save', async () => {
    const { get, save, file } = await setup()
    get()
    expect(save('', null).scratchpad.exists).toBe(false)
    expect(existsSync(file)).toBe(false)
  })

  it('refuses a save edited from a version that is gone, and writes nothing', async () => {
    const { get, save, file } = await setup()
    get()
    const first = save('one\n', null).scratchpad
    await writeFile(file, 'two\n')
    const refused = save('mine\n', first.version)
    expect(refused.outcome).toBe('conflict')
    // The answer is what is there now, for the client to merge into.
    expect(refused.scratchpad.content).toBe('two\n')
    expect(await readFile(file, 'utf8')).toBe('two\n')
    // Saved again from that version, it lands.
    expect(save('two\nmine\n', refused.scratchpad.version).outcome).toBe('saved')
    expect(await readFile(file, 'utf8')).toBe('two\nmine\n')
  })

  it('refuses a scratchpad too large for one message', async () => {
    const { get, run } = await setup()
    get()
    const answer = run('client-a', 'scratchpad.save', {
      workspaceId: 'workspace-1',
      content: 'x'.repeat(SCRATCHPAD_MAX_BYTES + 1),
      baseVersion: null,
    })
    expect(answer).toMatchObject({ type: 'error', error: { code: 'validation' } })
  })

  it('reports a file grown too large outside the panel without sending it', async () => {
    const { get, file } = await setup()
    await mkdir(join(file, '..'), { recursive: true })
    await writeFile(file, 'x'.repeat(SCRATCHPAD_MAX_BYTES + 10))
    expect(get()).toMatchObject({ exists: true, tooLarge: true, content: '' })
  })

  it('counts the cap as a save carries the text, so what it shows it can save', async () => {
    const { get, file, run } = await setup()
    await mkdir(join(file, '..'), { recursive: true })
    // 40,000 bytes on disk; over 60,000 as a JSON string.
    const quoted = '"x"\n'.repeat(10_000)
    await writeFile(file, quoted)
    expect(get()).toMatchObject({ exists: true, tooLarge: true, content: '' })
    expect(
      run('client-a', 'scratchpad.save', {
        workspaceId: 'workspace-1',
        content: quoted,
        baseVersion: null,
      }),
    ).toMatchObject({ type: 'error', error: { code: 'validation' } })
  })

  it('never writes over a file too large to show', async () => {
    const { get, save, file } = await setup()
    await mkdir(join(file, '..'), { recursive: true })
    const large = 'x'.repeat(SCRATCHPAD_MAX_BYTES + 10)
    await writeFile(file, large)
    const shown = get()
    // Even naming the version it was told, the panel cannot replace notes it never saw.
    expect(save('small\n', shown.version).outcome).toBe('conflict')
    expect(await readFile(file, 'utf8')).toBe(large)
  })

  it('has no scratchpad for No project', async () => {
    const { run, service } = await setup({ kind: 'scratch' })
    expect(run('client-a', 'scratchpad.get', { workspaceId: 'workspace-1' })).toMatchObject({
      type: 'error',
      error: { code: 'validation' },
    })
    expect(service.agentNote('workspace-1')).toBeUndefined()
  })

  it('answers not_found for a project it does not know', async () => {
    const { run } = await setup()
    expect(run('client-a', 'scratchpad.get', { workspaceId: 'elsewhere' })).toMatchObject({
      type: 'error',
      error: { code: 'not_found' },
    })
  })
})

describe('keeping .openmanager out of git', () => {
  it('adds one exclude line when the folder is first made in a checkout', async () => {
    const { get, save, root, file } = await setup({ git: true })
    await writeFile(join(root, '.git', 'info', 'exclude'), '# git ls-files --others\n*.log')
    get()
    const saved = save('notes\n', null).scratchpad
    const exclude = await readFile(join(root, '.git', 'info', 'exclude'), 'utf8')
    expect(exclude).toBe(
      "# git ls-files --others\n*.log\n# OpenManager's per-project scratchpad\n.openmanager/\n",
    )
    // The user's own ignore file is never touched.
    expect(existsSync(join(root, '.gitignore'))).toBe(false)
    // A later save, or the folder made again, adds nothing more.
    save('more\n', saved.version)
    await rm(join(file, '..'), { recursive: true })
    get()
    save('again\n', null)
    expect(await readFile(join(root, '.git', 'info', 'exclude'), 'utf8')).toBe(exclude)
  })

  it('adds the line whoever made the folder first', async () => {
    const { get, save, root, file } = await setup({ git: true })
    const exclude = join(root, '.git', 'info', 'exclude')
    // An agent made the folder and the file before the panel ever saved.
    await mkdir(join(file, '..'), { recursive: true })
    await writeFile(file, 'from the agent\n')
    const read = get()
    expect(await readFile(exclude, 'utf8')).toContain('.openmanager/\n')
    // Removed by hand, it comes back with the next save, once.
    await writeFile(exclude, '')
    save('mine\n', read.version)
    expect(await readFile(exclude, 'utf8')).toBe(
      "# OpenManager's per-project scratchpad\n.openmanager/\n",
    )
  })

  it('writes nothing outside a checkout', async () => {
    const { get, save, root } = await setup()
    get()
    save('notes\n', null)
    expect(existsSync(join(root, '.git'))).toBe(false)
  })

  it('finds the checkout above a project folder, and a worktree’s main repository', async () => {
    const base = await tempDir()
    // A repository whose project is a folder inside it.
    await mkdir(join(base, 'repo', '.git'), { recursive: true })
    await mkdir(join(base, 'repo', 'packages', 'app'), { recursive: true })
    excludeFromGit(join(base, 'repo', 'packages', 'app'))
    expect(await readFile(join(base, 'repo', '.git', 'info', 'exclude'), 'utf8')).toContain(
      '.openmanager/\n',
    )
    // A linked worktree: `.git` is a file naming its gitdir, which names the
    // repository it shares `info/exclude` with.
    const gitdir = join(base, 'main', '.git', 'worktrees', 'feature')
    await mkdir(gitdir, { recursive: true })
    await writeFile(join(gitdir, 'commondir'), '../..\n')
    await mkdir(join(base, 'feature'))
    await writeFile(join(base, 'feature', '.git'), `gitdir: ${gitdir}\n`)
    excludeFromGit(join(base, 'feature'))
    expect(await readFile(join(base, 'main', '.git', 'info', 'exclude'), 'utf8')).toContain(
      '.openmanager/\n',
    )
  })
})

describe('changes made outside the panel', () => {
  it('sends a change found on the next look, as made elsewhere', async () => {
    const { get, save, file, service, changes } = await setup()
    get('client-a')
    save('one\n', null)
    const before = changes('client-a').length
    await writeFile(file, 'one\ntwo\n')
    service.refreshAll()
    const change = changes('client-a').at(-1)!
    expect(changes('client-a')).toHaveLength(before + 1)
    expect(change.content).toBe('one\ntwo\n')
    expect(change.lastEdit?.by).toEqual({ kind: 'external' })
    // Nothing moved: nothing is sent again.
    service.refreshAll()
    expect(changes('client-a')).toHaveLength(before + 1)
  })

  it('puts a change down to the agent whose tool call just named the file', async () => {
    const { get, file, service, changes } = await setup()
    get('client-a')
    // A read names it too, and says nothing about who wrote.
    service.observeToolInput({
      sessionId: 'session-reader',
      workspaceId: 'workspace-1',
      providerId: 'opencode',
      kind: 'read',
      input: { path: SCRATCHPAD_PATH },
    })
    service.observeToolInput({
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
      providerId: 'claude',
      kind: 'edit',
      input: { file_path: join('/project', SCRATCHPAD_PATH), old_string: '', new_string: 'x' },
    })
    await mkdir(join(file, '..'), { recursive: true })
    await writeFile(file, 'from the agent\n')
    service.refreshAll()
    expect(changes('client-a').at(-1)?.lastEdit?.by).toEqual({
      kind: 'agent',
      sessionId: 'session-1',
      providerId: 'claude',
    })
  })

  it('stops watching once nobody follows, or the project is removed', async () => {
    const { get, service, disconnect } = await setup()
    get('client-a')
    expect(service.watching('workspace-1')).toBe(true)
    disconnect('client-a')
    service.refreshAll()
    expect(service.watching('workspace-1')).toBe(false)
    get('client-a')
    service.forget('workspace-1')
    expect(service.watching('workspace-1')).toBe(false)
  })

  it('hears a change on its own, by watch or poll', async () => {
    const { get, file, changes } = await setup({ pollMs: 25 })
    get('client-a')
    await mkdir(join(file, '..'), { recursive: true })
    await writeFile(file, 'live\n')
    await vi.waitFor(() => expect(changes('client-a').at(-1)?.content).toBe('live\n'), {
      timeout: 3_000,
    })
  })
})

describe('what agents are told', () => {
  it('points them at a shared scratchpad with something in it, and nothing else', async () => {
    const { get, save, service, setSharing } = await setup()
    // No file yet.
    expect(service.agentNote('workspace-1')).toBeUndefined()
    get()
    const blank = save('  \n', null).scratchpad
    // Only whitespace.
    expect(service.agentNote('workspace-1')).toBeUndefined()
    save('# Plan\n', blank.version)
    expect(service.agentNote('workspace-1')).toBe(
      "This project has a scratchpad at `.openmanager/scratchpad.md`, where the user keeps their own notes. Read it if the user refers to it or it's clearly relevant. Don't edit it unless the user asks you to.",
    )
    expect(service.agentNote('workspace-1')).toBe(scratchpadNote())
    // Off: not a word, though the file is still there.
    expect(setSharing(false).shareWithAgents).toBe(false)
    expect(service.agentNote('workspace-1')).toBeUndefined()
    expect(setSharing(true).shareWithAgents).toBe(true)
    expect(service.agentNote('workspace-1')).toBe(scratchpadNote())
  })

  it('keeps the sharing choice across a restart, per project', async () => {
    const { get, setSharing, dataDir, changes } = await setup()
    get('client-a')
    setSharing(false)
    // Followers hear the switch.
    expect(changes('client-a').at(-1)?.shareWithAgents).toBe(false)
    const reopened = openEnvironmentSettings(dataDir)
    stores.push(reopened)
    expect(reopened.sharesScratchpad('workspace-1')).toBe(false)
    expect(reopened.sharesScratchpad('workspace-2')).toBe(true)
  })
})

/** Wait for the next `scratchpad.changed` on a socket. */
async function nextChange(client: ProtocolClient): Promise<Scratchpad> {
  for (;;) {
    const message = await nextNonPing(client)
    if (message.type === 'event' && message.name === SCRATCHPAD_CHANGED_EVENT) {
      return ScratchpadChangedEventSchema.parse(message).payload.scratchpad
    }
  }
}

describe('the scratchpad over the socket', () => {
  it('reads, saves and sends changes to every connection that read it', async () => {
    const host = await startProtocolHost()
    const writer = await connectProtocol(host)
    const reader = await connectProtocol(host)
    await handshake(writer)
    await handshake(reader)
    const read = async (client: ProtocolClient) =>
      ScratchpadResponseSchemas['scratchpad.get'].parse(
        await nextResponse(
          client,
          client.command('scratchpad.get', { workspaceId: host.workspaceId }),
        ),
      ).payload.scratchpad
    expect((await read(writer)).exists).toBe(false)
    await read(reader)

    const saveId = writer.command('scratchpad.save', {
      workspaceId: host.workspaceId,
      content: 'hello\n',
      baseVersion: null,
    })
    const saved = ScratchpadResponseSchemas['scratchpad.save'].parse(
      await nextResponse(writer, saveId),
    ).payload
    expect(saved).toMatchObject({ outcome: 'saved', scratchpad: { content: 'hello\n' } })
    // Both sockets are the owner's credential, so both read the save as theirs.
    const heard = await nextChange(reader)
    expect(heard).toMatchObject({ content: 'hello\n', lastEdit: { by: { kind: 'you' } } })
    expect(await readFile(join(host.workspaceRoot, SCRATCHPAD_PATH), 'utf8')).toBe('hello\n')

    // The largest scratchpad, made of the characters that grow most in a
    // message, still goes in one the environment accepts.
    const heavy = '"\\\n'.repeat(Math.floor((SCRATCHPAD_MAX_BYTES - 2) / 6))
    const heavyId = writer.command('scratchpad.save', {
      workspaceId: host.workspaceId,
      content: heavy,
      baseVersion: saved.scratchpad.version,
    })
    expect(
      ScratchpadResponseSchemas['scratchpad.save'].parse(await nextResponse(writer, heavyId))
        .payload.outcome,
    ).toBe('saved')
    expect((await nextChange(reader)).content).toBe(heavy)

    await writeFile(join(host.workspaceRoot, SCRATCHPAD_PATH), 'hello\nfrom an editor\n')
    host.server.scratchpad.refreshAll()
    expect(await nextChange(reader)).toMatchObject({
      content: 'hello\nfrom an editor\n',
      lastEdit: { by: { kind: 'external' } },
    })
  })

  it("puts the note in a Claude session's system prompt while it is shared", async () => {
    // The runtime checks that the executable exists before the fake SDK takes
    // over, and the CI runners have no Claude Code. Any executable will do.
    vi.stubEnv('CLAUDE_CODE_BIN', process.execPath)
    const claude = new FakeClaudeSdk()
    let workspaceRoot = ''
    const host = await startProtocolHost({
      runtimeOptions: {
        connections: new FakeConnectionFactory(),
        claudeSdk: claude,
        health: { schedule: () => ({ cancel() {} }) },
      },
      resolveWorkspace: () => ({
        providerId: 'claude',
        providers: ['opencode', 'claude'],
        cwd: workspaceRoot,
      }),
    })
    workspaceRoot = host.workspaceRoot
    const client = await connectProtocol(host)
    await handshake(client)
    const create = () =>
      expectCommand(
        client,
        'session.create',
        {
          environmentId: host.server.identity.environmentId,
          providerId: 'claude',
          workspaceId: host.workspaceId,
        },
        'create',
      )

    // Empty: nothing to point at.
    await create()
    await vi.waitFor(() => expect(claude.queries).toHaveLength(1))
    expect(claude.queries[0]!.options.systemPrompt).toBeUndefined()

    await mkdir(join(host.workspaceRoot, '.openmanager'))
    await writeFile(join(host.workspaceRoot, SCRATCHPAD_PATH), '# Plan\n')
    await create()
    await vi.waitFor(() => expect(claude.queries).toHaveLength(2))
    expect(claude.queries[1]!.options.systemPrompt).toBe(scratchpadNote())

    const off = client.command('scratchpad.sharing.set', {
      workspaceId: host.workspaceId,
      shareWithAgents: false,
    })
    expect(await nextResponse(client, off)).toMatchObject({ type: 'response' })
    await create()
    await vi.waitFor(() => expect(claude.queries).toHaveLength(3))
    expect(claude.queries[2]!.options.systemPrompt).toBeUndefined()
  })
})
