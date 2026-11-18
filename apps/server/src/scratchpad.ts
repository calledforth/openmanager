import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  SCRATCHPAD_CHANGED_EVENT,
  SCRATCHPAD_GET_CAPABILITY,
  SCRATCHPAD_MAX_BYTES,
  SCRATCHPAD_PATH,
  SCRATCHPAD_SAVE_CAPABILITY,
  SCRATCHPAD_SHARING_SET_CAPABILITY,
  ScratchpadChangedEventSchema,
  scratchpadBytes,
  ScratchpadCommandSchemas,
  ScratchpadResponseSchemas,
  type CommandEnvelope,
  type ErrorCode,
  type EventEnvelope,
  type Scratchpad,
  type ScratchpadAuthor,
} from '@openmanager/protocol/node'
import type { AuthenticatedClient } from './authorized-clients.ts'
import type { CommandContext } from './command-context.ts'
import type { Logger } from './logger.ts'
import { PathBoundaryError, resolveWorkspacePath } from './workspace-paths.ts'
import type { RegisteredWorkspace } from './workspaces.ts'

/**
 * What an agent is told while its project's scratchpad is shared and has
 * something in it. A pointer, never the notes themselves: the agent reads
 * the file with its own tools when it is relevant, so a long scratchpad
 * costs nothing in a session that never needs it.
 */
export const scratchpadNote = (path: string = SCRATCHPAD_PATH): string =>
  `This project has a scratchpad at \`${path}\`, where the user keeps their own notes. ` +
  "Read it if the user refers to it or it's clearly relevant. " +
  "Don't edit it unless the user asks you to."

/** How often a watched scratchpad is looked at, whatever `fs.watch` says. */
export const SCRATCHPAD_POLL_MS = 2_000
/** How long a burst of `fs.watch` events is let settle before the file is read. */
const WATCH_SETTLE_MS = 100
/**
 * How close a change must be to a session's tool call naming the file for
 * the change to be put down to that session's agent. A tool call reports
 * its input as it starts and again as it settles, and the write falls
 * between; the slack covers a slow tool and the poll.
 */
export const SCRATCHPAD_ATTRIBUTION_WINDOW_MS = 30_000

/** Tool kinds that only look: naming the file in one says nothing about who wrote it. */
const LOOKING_TOOL_KINDS = new Set(['read', 'search', 'fetch', 'think'])

/** The last change seen, with the author as the environment knows it (no `you` yet). */
type Edit = {
  by: Exclude<ScratchpadAuthor, { kind: 'you' }>
  at: number
}

type Reading =
  | { exists: false }
  | {
      exists: true
      content: string
      tooLarge: boolean
      version: string
      modifiedAt: number
      signature: string
    }

/**
 * What the environment holds for one project's scratchpad: the version it
 * last saw (so a change is noticed once), who made the last change it saw,
 * and the watch while somebody follows it.
 */
type Tracked = {
  /** Undefined until the file is first read; null while there is no file. */
  version: string | null | undefined
  /** The file's stat when last read, so a poll that finds it unchanged reads nothing. */
  signature: string | null
  lastEdit: Edit | null
  /** The project's root while it is watched, as the command that started the watch resolved it. */
  root?: string
  poll?: ReturnType<typeof setInterval>
  watchers: FSWatcher[]
  settle?: ReturnType<typeof setTimeout>
}

/** A session whose agent last named the scratchpad in a tool call that can write. */
type Writer = { sessionId: string; providerId: string; at: number }

export interface ScratchpadSockets {
  hasFollowers(topic: string): boolean
  publishToFollowers(topic: string, build: (client: AuthenticatedClient) => EventEnvelope): void
}

export interface ScratchpadServiceDeps {
  workspaces: {
    /** Resolve for a command, auditing an unknown ID (registry `resolve`). */
    resolve(workspaceId: string, context?: CommandContext): RegisteredWorkspace | undefined
    /** Look up without auditing (registry `get`). */
    get(workspaceId: string): RegisteredWorkspace | undefined
    availability(workspaceId: string): 'unknown' | RegisteredWorkspace['availability']
  }
  sharing: {
    sharesScratchpad(workspaceId: string): boolean
    setScratchpadSharing(workspaceId: string, share: boolean): void
  }
  /** Read when a change is to be sent, once the socket server exists. */
  sockets: () => ScratchpadSockets
  log: Logger
  clock?: () => number
  pollMs?: number
  /** `fs.watch`, replaceable so a test can stand in for an unreliable one. */
  watch?: (path: string, onChange: () => void) => FSWatcher | undefined
}

const errorResult = (requestId: string, code: ErrorCode, message: string, details?: unknown) => ({
  type: 'error' as const,
  requestId,
  error: { code, message, ...(details === undefined ? {} : { details }) },
})

const topicOf = (workspaceId: string) => `${SCRATCHPAD_CHANGED_EVENT}:${workspaceId}`

const iso = (ms: number) => new Date(ms).toISOString()

/** `fs.watch`, or nothing where the platform will not watch that folder. */
function watchFolder(path: string, onChange: () => void): FSWatcher | undefined {
  try {
    const watcher = watch(path, { persistent: false }, () => onChange())
    // A watch that dies (its folder removed) leaves the poll to notice.
    watcher.on('error', () => watcher.close())
    return watcher
  } catch {
    return undefined
  }
}

/**
 * The scratchpad of every project: one markdown file per project at
 * `SCRATCHPAD_PATH`, read and written for clients, watched while a client
 * has it open, and pointed out to agents while its project shares it.
 *
 * The file is the only copy: an agent edits it with its own tools, the user
 * with the panel or any editor, and none of them goes through here first.
 * So a change is noticed, not announced. While anyone follows a project's
 * scratchpad the folder is watched with `fs.watch`, which is immediate where
 * it works, and the file's stat is polled every `SCRATCHPAD_POLL_MS`, which
 * works everywhere (`fs.watch` hears nothing on some mounts, such as a
 * Windows drive under WSL). Either one reads the file only when its stat
 * moved, and a change is sent only when its content did.
 *
 * Who changed it is a best guess, kept in memory: the panel's own saves are
 * known; a change close in time to a session's tool call naming the file is
 * put down to that session's agent; anything else was made elsewhere.
 */
export function createScratchpadService(deps: ScratchpadServiceDeps) {
  const clock = deps.clock ?? Date.now
  const pollMs = deps.pollMs ?? SCRATCHPAD_POLL_MS
  const watchPath = deps.watch ?? watchFolder
  const tracked = new Map<string, Tracked>()
  const writers = new Map<string, Writer>()

  const trackedOf = (workspaceId: string): Tracked => {
    let entry = tracked.get(workspaceId)
    if (!entry) {
      entry = { version: undefined, signature: null, lastEdit: null, watchers: [] }
      tracked.set(workspaceId, entry)
    }
    return entry
  }

  /** The file's absolute path. Throws `PathBoundaryError` for a folder linked out of the project. */
  const fileOf = (root: string) => resolveWorkspacePath(root, SCRATCHPAD_PATH)

  const signatureOf = (stat: { mtimeMs: number; size: number; ino: number }) =>
    `${stat.mtimeMs}:${stat.size}:${stat.ino}`

  const read = (file: string): Reading => {
    let stat
    try {
      stat = statSync(file)
    } catch (error) {
      if (isMissing(error)) return { exists: false }
      throw error
    }
    if (!stat.isFile()) throw new Error('The scratchpad is not a file.')
    const signature = signatureOf(stat)
    const large = (size: number): Reading => ({
      exists: true,
      content: '',
      tooLarge: true,
      // No hash of a file this large is taken: its size and time name it.
      version: `large-${size}-${Math.trunc(stat.mtimeMs)}`,
      modifiedAt: stat.mtimeMs,
      signature,
    })
    if (stat.size > SCRATCHPAD_MAX_BYTES) return large(stat.size)
    const bytes = readFileSync(file)
    const content = bytes.toString('utf8')
    // Grown between the stat and the read, or within the cap on disk but
    // over it as a save would carry it (quotes, backslashes, line breaks):
    // a client is only ever shown a scratchpad it could save back.
    if (bytes.length > SCRATCHPAD_MAX_BYTES || scratchpadBytes(content) > SCRATCHPAD_MAX_BYTES) {
      return large(bytes.length)
    }
    return {
      exists: true,
      content,
      tooLarge: false,
      version: versionOf(bytes),
      modifiedAt: stat.mtimeMs,
      signature,
    }
  }

  /** Who most likely made a change noticed now to a file last modified at `modifiedAt`. */
  const attribute = (workspaceId: string, modifiedAt: number): Edit['by'] => {
    const writer = writers.get(workspaceId)
    if (writer && Math.abs(modifiedAt - writer.at) <= SCRATCHPAD_ATTRIBUTION_WINDOW_MS) {
      return { kind: 'agent', sessionId: writer.sessionId, providerId: writer.providerId }
    }
    return { kind: 'external' }
  }

  /**
   * Read the file and note what changed since it was last read. The first
   * read since the environment started records no edit: whoever made the
   * file is not known. Answers whether the content moved.
   */
  const observe = (workspaceId: string, file: string): { reading: Reading; changed: boolean } => {
    const entry = trackedOf(workspaceId)
    const reading = read(file)
    const version = reading.exists ? reading.version : null
    const known = entry.version !== undefined
    const changed = known && version !== entry.version
    if (changed) {
      const at = reading.exists ? reading.modifiedAt : clock()
      entry.lastEdit = { by: attribute(workspaceId, at), at }
    }
    entry.version = version
    entry.signature = reading.exists ? reading.signature : null
    return { reading, changed }
  }

  /** Whether the file's stat moved since it was last read: a poll reads nothing otherwise. */
  const statMoved = (workspaceId: string, file: string): boolean => {
    const entry = trackedOf(workspaceId)
    if (entry.version === undefined) return true
    let signature: string | null = null
    try {
      signature = signatureOf(statSync(file))
    } catch (error) {
      if (!isMissing(error)) throw error
    }
    return signature !== entry.signature
  }

  /**
   * The scratchpad as it is now, for whoever reads it: `viewer`'s own saves
   * read as `you`. Taken whole when it is made, so a reading built later for
   * each follower still says what was true when it was sent.
   */
  const wireOf = (workspaceId: string, reading: Reading) => {
    const edit = trackedOf(workspaceId).lastEdit
    const shared: Scratchpad = {
      workspaceId,
      exists: reading.exists,
      content: reading.exists ? reading.content : '',
      tooLarge: reading.exists ? reading.tooLarge : false,
      version: reading.exists ? reading.version : null,
      modifiedAt: reading.exists ? iso(reading.modifiedAt) : null,
      lastEdit: edit ? { by: edit.by, at: iso(edit.at) } : null,
      shareWithAgents: deps.sharing.sharesScratchpad(workspaceId),
    }
    return (viewer: string | undefined): Scratchpad => {
      const by: ScratchpadAuthor | undefined =
        edit?.by.kind === 'client' && edit.by.clientId === viewer ? { kind: 'you' } : undefined
      return by && shared.lastEdit ? { ...shared, lastEdit: { ...shared.lastEdit, by } } : shared
    }
  }

  const toWire = (workspaceId: string, reading: Reading, viewer: string | undefined) =>
    wireOf(workspaceId, reading)(viewer)

  /** Tell everyone following this scratchpad how it reads now. */
  const publish = (workspaceId: string, reading: Reading) => {
    const topic = topicOf(workspaceId)
    try {
      const sockets = deps.sockets()
      if (!sockets.hasFollowers(topic)) return
      const scratchpadFor = wireOf(workspaceId, reading)
      sockets.publishToFollowers(topic, (client) =>
        ScratchpadChangedEventSchema.parse({
          type: 'event',
          name: SCRATCHPAD_CHANGED_EVENT,
          payload: { scratchpad: scratchpadFor(client.clientId) },
        }),
      )
    } catch (error) {
      deps.log('error', 'a scratchpad change was not sent', { reason: String(error) })
    }
  }

  const unwatch = (workspaceId: string) => {
    const entry = tracked.get(workspaceId)
    if (!entry) return
    if (entry.poll) clearInterval(entry.poll)
    if (entry.settle) clearTimeout(entry.settle)
    for (const watcher of entry.watchers) watcher.close()
    entry.poll = undefined
    entry.settle = undefined
    entry.watchers = []
    entry.root = undefined
  }

  /**
   * Look at a watched scratchpad: stop watching once nobody follows it,
   * otherwise send any change. The project itself is not looked up again
   * (looking at a project is what commands do, and records what they find);
   * a removed project stops its watch through `forget`.
   */
  const refresh = (workspaceId: string) => {
    const root = tracked.get(workspaceId)?.root
    if (!root || !deps.sockets().hasFollowers(topicOf(workspaceId))) {
      unwatch(workspaceId)
      return
    }
    try {
      const file = fileOf(root)
      watchFolders(workspaceId, root)
      if (!statMoved(workspaceId, file)) return
      const { reading, changed } = observe(workspaceId, file)
      if (changed) publish(workspaceId, reading)
    } catch (error) {
      deps.log('warn', 'the scratchpad could not be read', { workspaceId, reason: String(error) })
    }
  }

  /**
   * `fs.watch` the project's root (where `.openmanager` appears) and, once it
   * exists, `.openmanager` itself. Neither is recursive, so neither costs
   * more than one folder each; the poll covers whatever they miss.
   */
  const watchFolders = (workspaceId: string, root: string) => {
    const entry = trackedOf(workspaceId)
    const folder = join(root, dirname(SCRATCHPAD_PATH))
    const wanted = existsSync(folder) ? [root, folder] : [root]
    if (entry.watchers.length >= wanted.length) return
    for (const watcher of entry.watchers) watcher.close()
    const onChange = () => {
      if (entry.settle) return
      entry.settle = setTimeout(() => {
        entry.settle = undefined
        refresh(workspaceId)
      }, WATCH_SETTLE_MS)
      entry.settle.unref?.()
    }
    // A folder the platform will not watch is left to the poll.
    entry.watchers = wanted.flatMap((path) => watchPath(path, onChange) ?? [])
  }

  const startWatching = (workspaceId: string, root: string) => {
    const entry = trackedOf(workspaceId)
    if (entry.root !== root) unwatch(workspaceId)
    entry.root = root
    if (!entry.poll) {
      entry.poll = setInterval(() => refresh(workspaceId), pollMs)
      entry.poll.unref?.()
    }
    watchFolders(workspaceId, root)
  }

  /** The workspace a command names, or the error to answer it with. */
  const workspaceFor = (
    requestId: string,
    workspaceId: string,
    context?: CommandContext,
  ):
    | { workspace: RegisteredWorkspace; file: string }
    | { error: ReturnType<typeof errorResult> } => {
    const workspace = deps.workspaces.resolve(workspaceId, context)
    if (!workspace) {
      const availability = deps.workspaces.availability(workspaceId)
      return {
        error:
          availability === 'missing' || availability === 'inaccessible'
            ? errorResult(
                requestId,
                'workspace_unavailable',
                "The project's folder cannot be reached.",
                { workspaceId, availability },
              )
            : errorResult(requestId, 'not_found', 'That project is not registered.'),
      }
    }
    if (workspace.kind === 'scratch') {
      return { error: errorResult(requestId, 'validation', 'No project has no scratchpad.') }
    }
    try {
      return { workspace, file: fileOf(workspace.root) }
    } catch (error) {
      if (error instanceof PathBoundaryError) {
        return {
          error: errorResult(
            requestId,
            'validation',
            "The scratchpad's folder leads outside the project.",
          ),
        }
      }
      throw error
    }
  }

  const answer = <N extends keyof typeof ScratchpadResponseSchemas>(
    name: N,
    requestId: string,
    payload: unknown,
  ) => ScratchpadResponseSchemas[name].parse({ type: 'response', requestId, payload })

  const get = (command: CommandEnvelope, context?: CommandContext) => {
    const parsed = ScratchpadCommandSchemas[SCRATCHPAD_GET_CAPABILITY].safeParse(command)
    if (!parsed.success) {
      return errorResult(command.requestId, 'validation', 'Invalid scratchpad request.')
    }
    const { workspaceId } = parsed.data.payload
    const target = workspaceFor(command.requestId, workspaceId, context)
    if ('error' in target) return target.error
    // An agent or an editor may have made the folder: it stays out of git
    // however it came to be. Idempotent, and only once there is a folder.
    if (existsSync(dirname(target.file))) excludeFromGit(target.workspace.root, deps.log)
    const { reading, changed } = observe(workspaceId, target.file)
    // Changed while nobody watched: whoever still follows it hears too.
    if (changed) publish(workspaceId, reading)
    context?.follow?.(topicOf(workspaceId))
    startWatching(workspaceId, target.workspace.root)
    return answer(SCRATCHPAD_GET_CAPABILITY, command.requestId, {
      scratchpad: toWire(workspaceId, reading, context?.clientId),
    })
  }

  const save = (command: CommandEnvelope, context?: CommandContext) => {
    const parsed = ScratchpadCommandSchemas[SCRATCHPAD_SAVE_CAPABILITY].safeParse(command)
    if (!parsed.success) {
      return errorResult(command.requestId, 'validation', 'Invalid scratchpad save.')
    }
    const { workspaceId, content, baseVersion } = parsed.data.payload
    if (scratchpadBytes(content) > SCRATCHPAD_MAX_BYTES) {
      return errorResult(command.requestId, 'validation', 'The scratchpad is too large to save.')
    }
    const bytes = Buffer.from(content, 'utf8')
    const target = workspaceFor(command.requestId, workspaceId, context)
    if ('error' in target) return target.error
    const current = observe(workspaceId, target.file)
    if (current.changed) publish(workspaceId, current.reading)
    const currentVersion = current.reading.exists ? current.reading.version : null
    // Edited from a version that is no longer there: someone else wrote
    // since. Nothing is written; the client merges into what is there now.
    // A file too large to send is never written over from the panel, whose
    // user has not seen it: that is a conflict too, and the client keeps its
    // text rather than merging into one it cannot read.
    if (currentVersion !== baseVersion || (current.reading.exists && current.reading.tooLarge)) {
      return answer(SCRATCHPAD_SAVE_CAPABILITY, command.requestId, {
        outcome: 'conflict',
        scratchpad: toWire(workspaceId, current.reading, context?.clientId),
      })
    }
    // Nothing to keep and no file to keep it in: no file is made for it.
    if (!current.reading.exists && content === '') {
      return answer(SCRATCHPAD_SAVE_CAPABILITY, command.requestId, {
        outcome: 'saved',
        scratchpad: toWire(workspaceId, current.reading, context?.clientId),
      })
    }
    const folder = dirname(target.file)
    mkdirSync(folder, { recursive: true })
    // Whoever made the folder (this save, an agent, an editor), it stays out of git.
    excludeFromGit(target.workspace.root, deps.log)
    // Written beside the file and renamed over it, so an agent reading it
    // mid-save sees the old text or the new, never half of one.
    const temporary = join(folder, `.scratchpad.${randomUUID()}.tmp`)
    try {
      writeFileSync(temporary, bytes)
      renameSync(temporary, target.file)
    } catch (error) {
      rmSync(temporary, { force: true })
      throw error
    }
    const entry = trackedOf(workspaceId)
    entry.lastEdit = {
      by: { kind: 'client', clientId: context?.clientId ?? 'unknown' },
      at: clock(),
    }
    // Read back as anyone would see it, so the save itself is not later
    // noticed as somebody else's change.
    const reading = read(target.file)
    entry.version = reading.exists ? reading.version : null
    entry.signature = reading.exists ? reading.signature : null
    publish(workspaceId, reading)
    return answer(SCRATCHPAD_SAVE_CAPABILITY, command.requestId, {
      outcome: 'saved',
      scratchpad: toWire(workspaceId, reading, context?.clientId),
    })
  }

  const setSharing = (command: CommandEnvelope, context?: CommandContext) => {
    const parsed = ScratchpadCommandSchemas[SCRATCHPAD_SHARING_SET_CAPABILITY].safeParse(command)
    if (!parsed.success) {
      return errorResult(command.requestId, 'validation', 'Invalid scratchpad sharing request.')
    }
    const { workspaceId, shareWithAgents } = parsed.data.payload
    const target = workspaceFor(command.requestId, workspaceId, context)
    if ('error' in target) return target.error
    deps.sharing.setScratchpadSharing(workspaceId, shareWithAgents)
    const { reading } = observe(workspaceId, target.file)
    publish(workspaceId, reading)
    return answer(SCRATCHPAD_SHARING_SET_CAPABILITY, command.requestId, {
      scratchpad: toWire(workspaceId, reading, context?.clientId),
    })
  }

  return {
    /**
     * What agents of this workspace are told: the note, while the project
     * shares its scratchpad and the file has something in it; nothing
     * otherwise. Asked as an agent's process starts (`sessionInstructions`).
     */
    agentNote(workspaceId: string): string | undefined {
      const workspace = deps.workspaces.get(workspaceId)
      if (!workspace || workspace.kind === 'scratch') return undefined
      if (!deps.sharing.sharesScratchpad(workspaceId)) return undefined
      let reading: Reading
      try {
        reading = read(fileOf(workspace.root))
      } catch {
        return undefined
      }
      if (!reading.exists) return undefined
      if (!reading.tooLarge && reading.content.trim() === '') return undefined
      return scratchpadNote()
    },

    /**
     * A tool call's input, as a session's agent runs it: one that names the
     * scratchpad, and could write, makes that session the likely author of
     * a change noticed soon after.
     */
    observeToolInput(args: {
      sessionId: string
      workspaceId: string
      providerId: string
      kind: string | undefined
      input: unknown
    }) {
      if (args.kind !== undefined && LOOKING_TOOL_KINDS.has(args.kind)) return
      if (!mentionsScratchpad(args.input)) return
      writers.set(args.workspaceId, {
        sessionId: args.sessionId,
        providerId: args.providerId,
        at: clock(),
      })
    },

    dispatch(command: CommandEnvelope, context?: CommandContext): unknown {
      switch (command.name) {
        case SCRATCHPAD_GET_CAPABILITY:
          return get(command, context)
        case SCRATCHPAD_SAVE_CAPABILITY:
          return save(command, context)
        case SCRATCHPAD_SHARING_SET_CAPABILITY:
          return setSharing(command, context)
        default:
          return undefined
      }
    },

    /** A project was removed: stop watching it and forget what was known of it. */
    forget(workspaceId: string) {
      unwatch(workspaceId)
      tracked.delete(workspaceId)
      writers.delete(workspaceId)
    },

    /** Look at every watched scratchpad now, as the poll would. A test seam. */
    refreshAll() {
      for (const [workspaceId, entry] of tracked) if (entry.poll) refresh(workspaceId)
    },

    /** Whether a project's scratchpad is being watched. A test seam. */
    watching(workspaceId: string): boolean {
      return tracked.get(workspaceId)?.poll !== undefined
    },

    close() {
      for (const workspaceId of tracked.keys()) unwatch(workspaceId)
    },
  }
}

export type ScratchpadService = ReturnType<typeof createScratchpadService>

/** Names the content: the same text always has the same version. */
function versionOf(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 32)
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  )
}

/** The path as an agent's tool would spell it, on either kind of system. */
const SCRATCHPAD_PATHS = [SCRATCHPAD_PATH, SCRATCHPAD_PATH.replace('/', '\\')]

/** Whether any string in a tool's input names the scratchpad. Walks a few levels only. */
function mentionsScratchpad(input: unknown, depth = 0): boolean {
  if (typeof input === 'string') return SCRATCHPAD_PATHS.some((path) => input.includes(path))
  if (depth > 4 || !input || typeof input !== 'object') return false
  const values = Array.isArray(input) ? input : Object.values(input)
  return values.some((value) => mentionsScratchpad(value, depth + 1))
}

/**
 * Keep `.openmanager/` out of the project's git status, without touching
 * anything the user shares: a line in the repository's own
 * `info/exclude`, which is never committed. The checkout is found by
 * walking up from the project (which may be a folder inside one); a linked
 * worktree's exclude lives in the main repository, as git reads it. A line
 * that is already there is left alone, and a failure costs only a stray
 * folder in `git status`.
 */
export function excludeFromGit(root: string, log?: Logger): void {
  try {
    const gitDir = gitDirOf(root)
    if (!gitDir) return
    const exclude = join(gitDir, 'info', 'exclude')
    let current = ''
    try {
      current = readFileSync(exclude, 'utf8')
    } catch (error) {
      if (!isMissing(error)) throw error
    }
    const listed = current.split(/\r?\n/).some((line) => /^\/?\.openmanager\/?$/.test(line.trim()))
    if (listed) return
    mkdirSync(dirname(exclude), { recursive: true })
    const separator = current === '' || current.endsWith('\n') ? '' : '\n'
    writeFileSync(
      exclude,
      `${current}${separator}# OpenManager's per-project scratchpad\n.openmanager/\n`,
    )
  } catch (error) {
    log?.('warn', 'the scratchpad folder was not added to git exclude', {
      reason: String(error),
    })
  }
}

/** The git directory whose `info/exclude` covers `root`, if `root` is in a checkout. */
function gitDirOf(root: string): string | undefined {
  let current = resolve(root)
  for (;;) {
    const dotGit = join(current, '.git')
    if (existsSync(dotGit)) {
      let gitDir = dotGit
      if (statSync(dotGit).isFile()) {
        const match = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'))
        if (!match?.[1]) return undefined
        gitDir = resolve(current, match[1].trim())
      }
      // A linked worktree names the repository it shares its excludes with.
      const commonDir = join(gitDir, 'commondir')
      if (existsSync(commonDir)) {
        return resolve(gitDir, readFileSync(commonDir, 'utf8').trim())
      }
      return gitDir
    }
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}
