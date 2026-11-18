import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import type { EnvironmentClient, EnvironmentState } from '@openmanager/environment-client'
import {
  SCRATCHPAD_MAX_BYTES,
  scratchpadBytes,
  type Scratchpad,
  type ScratchpadEditRecord,
} from '@openmanager/protocol'
import type { ScratchpadEdit } from '../../components/scratchpad/ScratchpadPanel'
import { useEnvironmentClientOptional } from '../../providers/environment-client'
import { mergeLines } from './merge'

/**
 * A project's scratchpad, for the panel: the environment's file, the text
 * being typed, saving it, and what changed since the user last looked.
 *
 * - **Saving.** Each edit is shown at once and saved after a pause. A save
 *   names the version it was typed over; the environment refuses one whose
 *   file moved meanwhile, and the text is then merged (`mergeLines`: the
 *   user's lines win where both changed the same ones) and saved again.
 * - **Changes while typing.** One that arrives while the panel holds text not
 *   yet saved is not put into the editor: the text box never changes under
 *   the user's hands. It is merged in by that save instead, through the
 *   refusal above. One that arrives with nothing unsaved simply shows.
 * - **Unseen.** The text as the user last saw it is kept per project on this
 *   device. When the environment's text differs and someone else wrote it,
 *   the panel says so and can diff it; marking it read (or saving over it)
 *   moves the mark. A project first opened here starts with nothing unseen.
 */

export const SCRATCHPAD_SAVE_DELAY_MS = 500

/** Where the text last seen is kept, per project. */
export interface ScratchpadSeenStore {
  get(key: string): string | null
  set(key: string, value: string): void
}

const memorySeen = new Map<string, string>()

/**
 * `localStorage` where there is one, else this page's memory: a device that
 * cannot keep it shows a change as unseen again after a reload, no worse.
 */
export const localSeenStore: ScratchpadSeenStore = {
  get(key) {
    try {
      const stored = globalThis.localStorage?.getItem(key)
      if (stored !== undefined && stored !== null) return stored
    } catch {
      // Storage refused (private mode, quota): memory below.
    }
    return memorySeen.get(key) ?? null
  },
  set(key, value) {
    memorySeen.set(key, value)
    try {
      globalThis.localStorage?.setItem(key, value)
    } catch {
      // Memory still has it for this page.
    }
  },
}

export interface ScratchpadView {
  /** Whether the environment has scratchpads at all. */
  supported: boolean
  /** Nothing read yet. */
  loading: boolean
  /** Why the last read failed; null once one works. */
  error: string | null
  /** The file grew past what the panel can carry; it is not shown. */
  tooLarge: boolean
  /** What the panel shows: the text being typed, else the file's. */
  content: string
  lastEdit: ScratchpadEdit | null
  unseen: (ScratchpadEdit & { before: string }) | null
  shareWithAgents: boolean
  saveState: 'saved' | 'saving' | 'error'
}

const EMPTY_VIEW: ScratchpadView = {
  supported: false,
  loading: false,
  error: null,
  tooLarge: false,
  content: '',
  lastEdit: null,
  unseen: null,
  shareWithAgents: true,
  saveState: 'saved',
}

export interface ScratchpadControllerOptions {
  client: EnvironmentClient
  workspaceId: string
  /** Names this environment in the seen store, beside the project. */
  environmentId: string
  seen?: ScratchpadSeenStore
  saveDelayMs?: number
  /** An agent's name for the panel, from its provider id. */
  providerName?: (providerId: string) => string
  /** Called once a closed controller has nothing left to save. */
  onRetire?: () => void
}

export const scratchpadSeenKey = (environmentId: string, workspaceId: string) =>
  `openmanager:scratchpad-seen:${environmentId}:${workspaceId}`

/**
 * Where text not yet saved waits when its panel goes away (the user opened
 * another session) before the save landed, with the version it was typed
 * over. The next panel for the project picks it up and saves it.
 */
export const scratchpadUnsavedKey = (environmentId: string, workspaceId: string) =>
  `openmanager:scratchpad-unsaved:${environmentId}:${workspaceId}`

type Base = { version: string | null; content: string }

const readUnsaved = (raw: string | null): { draft: string; base: Base } | null => {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as {
      draft?: unknown
      base?: { version?: unknown; content?: unknown }
    }
    if (typeof value.draft !== 'string' || typeof value.base?.content !== 'string') return null
    const version = value.base.version
    if (version !== null && typeof version !== 'string') return null
    return { draft: value.draft, base: { version, content: value.base.content } }
  } catch {
    return null
  }
}

/** Why the panel will not merge: the file is there but too large for it to read. */
const TOO_LARGE_TO_MERGE =
  'The scratchpad grew too large to show here, so your text was not saved over it. It is kept here: copy it out, then discard it.'
/** Why the panel will not merge: the two texts differ too much to merge on this page. */
const TOO_DIFFERENT_TO_MERGE =
  'The scratchpad changed elsewhere too much to merge with your text, so yours was not saved. It is kept here: copy it out, then discard it.'

/**
 * The scratchpad of one project on one client, outside React so its timing
 * can be tested on its own. `useScratchpad` binds one to a view.
 */
export function createScratchpadController(options: ScratchpadControllerOptions) {
  const { client, workspaceId } = options
  const seenStore = options.seen ?? localSeenStore
  const seenKey = scratchpadSeenKey(options.environmentId, workspaceId)
  const unsavedKey = scratchpadUnsavedKey(options.environmentId, workspaceId)
  const delay = options.saveDelayMs ?? SCRATCHPAD_SAVE_DELAY_MS
  const listeners = new Set<() => void>()

  /** The environment's file, as last heard. */
  let server: Scratchpad | null = null
  /**
   * What `draft` was typed over: the version a save names, and the text a
   * merge starts from. Null until the panel has read a file it can show: a
   * merge never starts from text it does not have.
   */
  let base: Base | null = null
  // Text a closed panel for this project left unsaved comes back to be saved.
  const left = readUnsaved(seenStore.get(unsavedKey))
  /** The text typed and not yet saved; null when the editor shows the file. */
  let draft: string | null = left?.draft ?? null
  if (left) base = left.base
  let seen: string | null = seenStore.get(seenKey)
  let saveState: ScratchpadView['saveState'] = left ? 'saving' : 'saved'
  let error: string | null = null
  let saving = false
  let timer: ReturnType<typeof setTimeout> | undefined
  /**
   * The panel is gone: nothing is shown or heard any more, but a save under
   * way, and any text typed after it, still goes out (merging if it must).
   */
  let disposed = false
  /** A closed controller with nothing left to send lets its registry forget it. */
  let retired = false
  const retireIfIdle = () => {
    if (!disposed || retired || saving || timer) return
    if (draft !== null && saveState !== 'error') return
    retired = true
    options.onRetire?.()
  }
  /** Whether the device holds unsaved text for this project, to drop once it is saved. */
  let stored = left !== null
  /** Keep (or drop) the text a closed panel has not saved yet. */
  const keepUnsaved = () => {
    const keep = draft !== null && base !== null
    if (!keep && !stored) return
    seenStore.set(unsavedKey, keep ? JSON.stringify({ draft, base }) : '')
    stored = keep
  }
  let view: ScratchpadView = { ...EMPTY_VIEW, supported: true, loading: true }

  const authorOf = (edit: ScratchpadEditRecord): ScratchpadEdit => {
    const by = edit.by
    switch (by.kind) {
      // Another device is the user too.
      case 'you':
      case 'client':
        return { by: { kind: 'you' }, at: edit.at }
      case 'agent':
        return {
          by: { kind: 'agent', name: options.providerName?.(by.providerId) ?? by.providerId },
          at: edit.at,
        }
      case 'external':
        return { by: { kind: 'external' }, at: edit.at }
    }
  }

  const markSeen = (content: string) => {
    if (seen === content) return
    seen = content
    seenStore.set(seenKey, content)
  }

  const render = () => {
    const lastEdit = server?.lastEdit ? authorOf(server.lastEdit) : null
    const content = draft ?? server?.content ?? ''
    // Only the file can be unseen, and only while nothing is being typed:
    // the user's own unsaved text is not news to them.
    const unseen =
      server && draft === null && seen !== null && seen !== server.content && !server.tooLarge
        ? {
            ...(lastEdit ?? { by: { kind: 'external' as const }, at: server.modifiedAt ?? '' }),
            before: seen,
          }
        : null
    view = {
      supported: true,
      loading: server === null && error === null,
      error,
      // A draft is shown even over a file too large to show: it is the user's.
      tooLarge: (server?.tooLarge ?? false) && draft === null,
      content,
      lastEdit,
      unseen,
      shareWithAgents: server?.shareWithAgents ?? true,
      saveState,
    }
    for (const listener of [...listeners]) listener()
  }

  /** The environment's word on the file: a read, a save's answer, or a change. */
  const accept = (next: Scratchpad) => {
    if (next.workspaceId !== workspaceId) return
    server = next
    // A first look here is a look at all of it.
    if (seen === null) markSeen(next.content)
    // The user's own writes, from here or another tab, are seen as written.
    if (next.lastEdit?.by.kind === 'you') markSeen(next.content)
    // Text that is already the file's (a kept draft whose save landed after
    // all) is not a draft: saving it again could only bring back lines
    // since removed.
    if (draft !== null && !saving && !next.tooLarge && next.content === draft) {
      draft = null
      saveState = 'saved'
      error = null
      keepUnsaved()
    }
    if (draft === null)
      base = next.tooLarge ? null : { version: next.version, content: next.content }
  }

  const fail = (reason: unknown, fallback: string) =>
    reason instanceof Error && reason.message ? reason.message : fallback

  const save = async () => {
    if (saving || draft === null) return
    if (scratchpadBytes(draft) > SCRATCHPAD_MAX_BYTES) {
      saveState = 'error'
      render()
      retireIfIdle()
      return
    }
    // Typed before the file could be read: nothing to name or merge from yet.
    if (!base) return
    saving = true
    const sent = draft
    try {
      const result = await client.commands.saveScratchpad({
        workspaceId,
        content: sent,
        baseVersion: base.version,
      })
      if (result.outcome === 'saved') {
        accept(result.scratchpad)
        markSeen(result.scratchpad.content)
        base = { version: result.scratchpad.version, content: result.scratchpad.content }
        // Typed on while it was out: that text waits for the next save.
        if (draft === sent) {
          draft = null
          saveState = 'saved'
          error = null
        }
      } else if (result.scratchpad.tooLarge) {
        // The file grew past what the panel can read. There is no text to
        // merge with, and saving over it would replace notes nobody here
        // has seen: the user's text stays put, unsaved, and the panel says why.
        server = result.scratchpad
        saveState = 'error'
        error = TOO_LARGE_TO_MERGE
      } else {
        // Someone wrote first. Their text and the user's are merged from the
        // version the user typed over, and that goes out at once, over theirs.
        const theirs = result.scratchpad
        const merged = mergeLines(base.content, draft ?? sent, theirs.content)
        server = theirs
        if (merged === null) {
          // Too different to merge here: kept, not guessed at.
          saveState = 'error'
          error = TOO_DIFFERENT_TO_MERGE
        } else {
          draft = merged
          base = { version: theirs.version, content: theirs.content }
          saveState = 'saving'
        }
      }
    } catch {
      // Kept in the editor; the next edit, or the next connection, tries again.
      saveState = 'error'
    } finally {
      saving = false
    }
    // Kept for a closed panel; dropped once what was kept is saved.
    if (disposed || stored) keepUnsaved()
    render()
    if (draft !== null && saveState !== 'error') schedule(0)
    else retireIfIdle()
  }

  const schedule = (ms: number) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      void save()
    }, ms)
  }

  return {
    getSnapshot: () => view,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    /** Read the file, which also asks to hear its changes on this connection. */
    async load() {
      try {
        const next = await client.commands.getScratchpad(workspaceId)
        if (disposed) return
        error = null
        accept(next)
      } catch (reason) {
        if (disposed) return
        error = fail(reason, 'The scratchpad could not be read.')
      }
      render()
      // Text typed while the connection was down goes out now.
      if (draft !== null && !timer) schedule(0)
    },

    /** A change the environment sent. While text is being typed it waits for the save. */
    receive(next: Scratchpad) {
      if (disposed || next.workspaceId !== workspaceId) return
      accept(next)
      render()
    },

    edit(content: string) {
      if (disposed) return
      draft = content === (server?.content ?? '') && !saving && !server?.tooLarge ? null : content
      saveState = draft === null ? 'saved' : 'saving'
      render()
      if (draft !== null) schedule(delay)
      else if (timer) clearTimeout(timer)
    },

    /**
     * Drop the text that could not be saved (after copying it out) and show
     * the file as it is. The way out of a refused merge.
     */
    discard() {
      if (timer) clearTimeout(timer)
      timer = undefined
      draft = null
      error = null
      saveState = 'saved'
      base =
        server && !server.tooLarge ? { version: server.version, content: server.content } : null
      keepUnsaved()
      render()
    },

    /** A panel shows this controller again; see `scratchpadControllerFor`. */
    open() {
      disposed = false
    },

    /** The user has looked at the file as it is now. */
    markSeen() {
      if (server) markSeen(server.content)
      render()
    },

    async setShareWithAgents(next: boolean) {
      try {
        accept(await client.commands.setScratchpadSharing({ workspaceId, shareWithAgents: next }))
      } catch (reason) {
        error = fail(reason, 'Sharing could not be changed.')
      }
      if (!disposed) render()
    },

    /** Save what is waiting now, rather than after the pause. */
    flush() {
      if (timer) {
        clearTimeout(timer)
        timer = undefined
        void save()
      }
    },

    /**
     * The panel is going away. What is waiting is sent now, and a save
     * already out carries on to the end (a merge included). Whatever is
     * still unsaved is kept on the device for the project's next panel,
     * until a save lands.
     */
    dispose() {
      this.flush()
      disposed = true
      listeners.clear()
      keepUnsaved()
      retireIfIdle()
    },
  }
}

/**
 * Every controller still alive, closed ones still saving included, by
 * client and project. A panel opened for a project whose last panel is
 * still saving takes that same controller back, so a project never has two
 * saves racing each other (the second would read the first as someone
 * else's edit and merge deleted lines back in).
 */
const controllers = new WeakMap<EnvironmentClient, Map<string, ScratchpadController>>()

/** The project's controller on this client: the live one if there is one, else a new one. */
export function scratchpadControllerFor(
  options: ScratchpadControllerOptions,
): ScratchpadController {
  let byProject = controllers.get(options.client)
  if (!byProject) controllers.set(options.client, (byProject = new Map()))
  const key = scratchpadUnsavedKey(options.environmentId, options.workspaceId)
  const live = byProject.get(key)
  if (live) return live
  const created = createScratchpadController({
    ...options,
    onRetire: () => {
      if (byProject.get(key) === created) byProject.delete(key)
      options.onRetire?.()
    },
  })
  byProject.set(key, created)
  return created
}

export type ScratchpadController = ReturnType<typeof createScratchpadController>

const subscribeToNothing = () => () => undefined
const selectConnected = (state: EnvironmentState) => state.connection.phase === 'connected'
const selectEnvironmentId = (state: EnvironmentState) => state.environment?.environmentId ?? null

export interface ScratchpadActions {
  /** Drop text that could not be saved, once the user has copied it out. */
  onDiscard: () => void
  onChange: (content: string) => void
  onMarkSeen: () => void
  onShareWithAgentsChange: (next: boolean) => void
}

/**
 * A project's scratchpad on the surrounding environment's client, read on
 * every connection (a reconnect has to ask again to keep hearing changes).
 * `workspaceId` null, or an environment without scratchpads, reads as
 * unsupported and does nothing.
 */
export function useScratchpad(
  workspaceId: string | null,
  options: { seen?: ScratchpadSeenStore; saveDelayMs?: number } = {},
): ScratchpadView & ScratchpadActions {
  const client = useEnvironmentClientOptional()
  const read =
    <T>(select: (state: EnvironmentState) => T, fallback: T) =>
    () =>
      client ? select(client.getState()) : fallback
  const connected = useSyncExternalStore(
    client?.subscribe ?? subscribeToNothing,
    read(selectConnected, false),
    read(selectConnected, false),
  )
  const environmentId = useSyncExternalStore(
    client?.subscribe ?? subscribeToNothing,
    read(selectEnvironmentId, null),
    read(selectEnvironmentId, null),
  )
  // Known from the first handshake on, and kept through a drop, so the panel
  // and any unsaved text stay put while the connection comes back.
  const supported = useSyncExternalStore(
    client?.subscribe ?? subscribeToNothing,
    () => client?.supports('getScratchpad') ?? false,
    () => client?.supports('getScratchpad') ?? false,
  )
  const { seen, saveDelayMs } = options
  const controller = useMemo(
    () =>
      client && workspaceId && environmentId
        ? scratchpadControllerFor({
            client,
            workspaceId,
            environmentId,
            ...(seen ? { seen } : {}),
            ...(saveDelayMs !== undefined ? { saveDelayMs } : {}),
            providerName: (providerId) =>
              client.getState().providers[providerId]?.displayName ?? providerId,
          })
        : null,
    [client, workspaceId, environmentId, seen, saveDelayMs],
  )
  // Shown from mount to unmount; closed, it may still be finishing a save,
  // and the next panel for the project takes it back.
  useEffect(() => {
    if (!controller) return
    controller.open()
    return () => controller.dispose()
  }, [controller])
  useEffect(() => {
    if (!controller || !client?.onScratchpadChanged) return
    return client.onScratchpadChanged((next) => controller.receive(next))
  }, [client, controller])
  // Every connection reads it again: hearing its changes lasts as long as
  // the connection that asked.
  useEffect(() => {
    if (controller && supported && connected) void controller.load()
  }, [controller, supported, connected])

  const view = useSyncExternalStore(
    controller?.subscribe ?? subscribeToNothing,
    controller?.getSnapshot ?? (() => EMPTY_VIEW),
    controller?.getSnapshot ?? (() => EMPTY_VIEW),
  )
  const onChange = useCallback((content: string) => controller?.edit(content), [controller])
  const onMarkSeen = useCallback(() => controller?.markSeen(), [controller])
  const onDiscard = useCallback(() => controller?.discard(), [controller])
  const onShareWithAgentsChange = useCallback(
    (next: boolean) => void controller?.setShareWithAgents(next),
    [controller],
  )
  return {
    ...(supported ? view : EMPTY_VIEW),
    onChange,
    onMarkSeen,
    onDiscard,
    onShareWithAgentsChange,
  }
}
