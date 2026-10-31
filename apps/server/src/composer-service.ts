import { isDeepStrictEqual } from 'node:util'
import {
  COMPOSER_CONFIG_OPTION_SET_CAPABILITY,
  COMPOSER_MODEL_SET_CAPABILITY,
  COMPOSER_MODE_SET_CAPABILITY,
  COMPOSER_PREFERENCES_SET_CAPABILITY,
  ComposerCommandOptionSchema,
  ComposerCommandSchemas,
  ComposerConfigOptionSchema,
  ComposerListingSchema,
  ComposerResponseSchemas,
  ComposerUsageSchema,
  PROVIDER_CATALOG_CAPABILITY,
  SessionComposerStateSchema,
  type CommandEnvelope,
  type ComposerCommandOption,
  type ComposerConfigOption,
  type ComposerListing,
  type ComposerModelOption,
  type ComposerPreferenceTarget,
  type ErrorCode,
  type PromptCapabilities,
  type ProofEvent,
  type ProviderBootstrap,
  type SessionComposerState,
  type WorkspaceComposerPreference,
} from '@openmanager/protocol/node'
import type {
  AgentRuntime,
  DesiredSessionConfig,
  HostDeps,
  ProviderBootstrap as RuntimeProviderBootstrap,
  ProviderCatalog as RuntimeProviderCatalog,
  RuntimeRoute,
} from '@agentpack/runtime/node'
import type { CommandContext } from './command-context.ts'
import type { ComposerStore, RevisedPreference } from './composer-store.ts'

type RuntimeTarget = RuntimeRoute & { sessionId: string }
/**
 * The live runtime a session setter acts on, after loading the session if
 * this process has not (thread-service.ts `resolveRuntimeSession`). A refusal
 * is the answer an open of it would give; nothing means it does not exist.
 */
type ResolveSession = (
  sessionId: string,
  context?: CommandContext,
) => Promise<RuntimeTarget> | { code: ErrorCode; message: string; details?: unknown } | undefined
type ProviderSource = {
  snapshot(): ProviderBootstrap[]
  rejection(providerId: string): { code: ErrorCode; message: string } | undefined
}
type RuntimeControl = Pick<
  AgentRuntime,
  'setModel' | 'setMode' | 'setConfigOption' | 'applyDesiredConfig' | 'modelImageInputSupport'
>

type ComposerEventName = 'session.composer.updated' | 'composer.listing.updated'
type ComposerEventPayload<N extends ComposerEventName> = Extract<ProofEvent, { name: N }>['payload']

export interface ComposerServiceOptions {
  /**
   * Announce a session's selection to every client. The host wraps the
   * payload in a durable environment event, whose projection stores it, so a
   * reconnecting client replays it. Profiles and workspace preferences are
   * the composer store's own events. Without a publisher the service still
   * tracks selections in memory, for tests and offline hosts.
   */
  publish?: <N extends ComposerEventName>(name: N, payload: ComposerEventPayload<N>) => void
  /**
   * Announce what changed in what the provider offers a chat, in that chat's
   * own stream: a listing is too large to send every browser for every
   * session, and too large to store again for a change to one field.
   */
  publishThreadListing?: (
    target: { sessionId: string; threadId: string },
    changed: ComposerListing,
  ) => void
  /** The host session that owns a runtime thread; probes and unknown threads have none. */
  sessionForThread?: (threadId: string) => string | undefined
  /** The session's persisted selection. Without it selections live in memory. */
  readSessionComposer?: (sessionId: string) => SessionComposerState | undefined
  /** The chat's persisted listing. Without it listings live in memory. */
  readThreadListing?: (threadId: string) => ComposerListing | undefined
  /** What the provider last listed in this workspace, for a new chat to borrow, and who said so. */
  readWorkspaceListing?: (
    target: ComposerPreferenceTarget,
  ) => { listing: ComposerListing; sourceSessionId: string } | undefined
  /** The workspace and provider a session lists for. Without it nothing is kept for new chats. */
  listingTarget?: (sessionId: string) => ComposerPreferenceTarget | undefined
  /**
   * Whether the session still has its row. A selection reported for one
   * being deleted is not announced: its projection would have no row to
   * write (I2). Without it every session is taken to exist.
   */
  hasSession?: (sessionId: string) => boolean
  /**
   * When a session was last active, if it still exists: `sessions.updated_at`,
   * which a title does not move. Without it every report stands.
   */
  sessionActivity?: (sessionId: string) => number | undefined
  /**
   * How long to wait before asking again about models the lookup could not
   * answer *right now* (its CLI failed or is held after a failure). Defaults
   * to the runtime's own failure hold, so the retry lands once it has lifted.
   */
  modelImageInputRetryMs?: number
  /** Timer seam for that retry; defaults to an unref'd `setTimeout`. */
  scheduleModelImageInputRetry?: (run: () => void, delayMs: number) => () => void
}

const MODEL_IMAGE_INPUT_RETRY_MS = 5 * 60 * 1000

const scheduleUnref = (run: () => void, delayMs: number) => {
  const timer = setTimeout(run, delayMs)
  timer.unref?.()
  return () => clearTimeout(timer)
}

const PREFERENCE_NOT_SAVED = 'The preference could not be saved. Try again.'

const errorResult = (requestId: string, code: ErrorCode, message: string, details?: unknown) => ({
  type: 'error' as const,
  requestId,
  error: { code, message, ...(details === undefined ? {} : { details }) },
})

/** Provider catalog, durable composer preferences, and live runtime controls. */
export function createComposerService(
  runtime: RuntimeControl,
  providers: ProviderSource,
  store: ComposerStore,
  resolveSession: ResolveSession,
  options: ComposerServiceOptions = {},
) {
  const providerExists = (providerId: string) =>
    providers.snapshot().some((provider) => provider.id === providerId)

  // A selection that cannot be written must fail neither the command nor the
  // runtime's event delivery: the provider already runs on it, so memory keeps
  // it (below) until a later write lands.
  const publish = <N extends ComposerEventName>(
    name: N,
    payload: ComposerEventPayload<N>,
  ): boolean => {
    try {
      options.publish?.(name, payload)
      return true
    } catch {
      // Clients converge on their next catalog or preference read.
      return false
    }
  }

  const writeProfile = (
    providerId: string,
    patch: Parameters<ComposerStore['upsertProfile']>[1],
    // The enrichment's own write must not start another pass over itself.
    { enrich = true }: { enrich?: boolean } = {},
  ) => {
    if (Object.keys(patch).length === 0) return
    const before = store.getProfile(providerId)
    // The store announces a change; its projection writes the row.
    store.upsertProfile(providerId, {
      ...patch,
      // A relisting replaces the rows but must not forget what was learned
      // about them: image support, the context window and the model's own
      // settings describe the model, not the session that listed it, and an
      // ACP session's listing carries none of them.
      ...(patch.availableModels
        ? { availableModels: withKnownModelFacts(patch.availableModels, before?.availableModels) }
        : {}),
    })
    if (enrich && patch.availableModels) enrichModelImageInput(providerId)
  }

  // One enrichment per provider at a time. A catalog write that lands while
  // one runs marks it dirty, so the pass repeats against the new rows rather
  // than a second pass racing the first over the same profile.
  const enrichments = new Map<string, { dirty: boolean }>()
  // Rows the lookup could not answer *right now* are asked about again after
  // the hold, independently of catalog writes: a stable catalog listed while
  // the CLI was down would otherwise stay unresolved, and unresolved lets
  // images through. One timer per provider; a new pass replaces it.
  const retries = new Map<string, () => void>()
  const retryMs = options.modelImageInputRetryMs ?? MODEL_IMAGE_INPUT_RETRY_MS
  const schedule = options.scheduleModelImageInputRetry ?? scheduleUnref
  // Once stopped nothing is asked or scheduled again: a retry firing after
  // the store closed would fail, be caught, and schedule itself forever.
  let stopped = false
  const enrichModelImageInput = (providerId: string) => {
    retries.get(providerId)?.()
    retries.delete(providerId)
    if (stopped) return
    const running = enrichments.get(providerId)
    if (running) {
      running.dirty = true
      return
    }
    const state = { dirty: false }
    enrichments.set(providerId, state)
    void (async () => {
      let unanswered = false
      try {
        do {
          state.dirty = false
          unanswered = await enrichModelImageInputOnce(providerId)
        } while (state.dirty)
      } catch {
        // Model metadata is advisory; an unanswerable lookup leaves rows
        // unknown, and unknown is exactly what a retry is for.
        unanswered = true
      } finally {
        enrichments.delete(providerId)
      }
      if (unanswered && !stopped && !retries.has(providerId)) {
        retries.set(
          providerId,
          schedule(() => {
            retries.delete(providerId)
            enrichModelImageInput(providerId)
          }, retryMs),
        )
      }
    })()
  }

  /** One pass. Resolves to whether any row was left for a later retry. */
  const enrichModelImageInputOnce = async (providerId: string): Promise<boolean> => {
    const pending = (store.getProfile(providerId)?.availableModels ?? [])
      .filter((model) => model.supportsImageInput === undefined)
      .map((model) => model.modelId)
    if (pending.length === 0) return false
    const answers = await runtime.modelImageInputSupport(providerId, pending)
    // Merged against the profile as it is *now*, not the snapshot the ids
    // came from: a session may have relisted the catalog while the CLI ran.
    const current = store.getProfile(providerId)?.availableModels
    if (!current) return false
    let changed = false
    const availableModels = current.map((model) => {
      const answer = answers.get(model.modelId)
      if (model.supportsImageInput !== undefined || typeof answer !== 'boolean') return model
      changed = true
      return { ...model, supportsImageInput: answer }
    })
    if (changed) writeProfile(providerId, { availableModels }, { enrich: false })
    // `null` is an answer ("nobody can say") and is kept; an id the lookup
    // did not mention at all could not be asked about and is worth retrying.
    return pending.some((modelId) => !answers.has(modelId))
  }

  /** The store announces a change with its revision; its projection writes both. */
  const writePreference = (
    workspaceId: string,
    providerId: string,
    patch: Parameters<ComposerStore['setPreference']>[2],
  ) => store.setPreference(workspaceId, providerId, patch)

  // With a persisted reader this only holds selections whose durable write
  // failed: the provider already runs on them, so reads and the next prompt
  // must keep answering with them until a later write lands.
  const memorySelections = new Map<string, SessionComposerState>()
  const selectionOf = (sessionId: string): SessionComposerState =>
    memorySelections.get(sessionId) ?? options.readSessionComposer?.(sessionId) ?? {}

  /**
   * A session's selection is its own: changing it never reaches a sibling
   * session in the same workspace. The publisher persists it with the event.
   */
  const updateSelection = (sessionId: string, patch: Partial<SessionComposerState>) => {
    const current = selectionOf(sessionId)
    const merged = SessionComposerStateSchema.safeParse({ ...current, ...defined(patch) })
    if (!merged.success || isDeepStrictEqual(merged.data, current)) return current
    if (options.hasSession && !options.hasSession(sessionId)) {
      memorySelections.delete(sessionId)
      return current
    }
    const persisted = publish('session.composer.updated', { sessionId, composer: merged.data })
    if (persisted && options.readSessionComposer) memorySelections.delete(sessionId)
    else memorySelections.set(sessionId, merged.data)
    return merged.data
  }

  /**
   * Whether a chat's report gives way to the chat that wrote the workspace's
   * listing. Ties go the way the sidebar and migration 23 order sessions, so
   * of two chats exactly one ever outranks the other. A writer that no longer
   * exists holds nothing, and the next report wins.
   */
  const givesWayTo = (sessionId: string, writer: string) => {
    if (writer === sessionId) return false
    const reporterAt = options.sessionActivity?.(sessionId)
    const writerAt = options.sessionActivity?.(writer)
    if (reporterAt === undefined || writerAt === undefined) return false
    return reporterAt === writerAt ? sessionId < writer : reporterAt < writerAt
  }

  /**
   * A new chat has no session to list for it, so the workspace keeps what its
   * provider last listed, as the most recently active chat listed it: two
   * chats with different lists, say one with an extra MCP server, would
   * otherwise take turns overwriting the row for as long as both reported.
   *
   * An empty command list is the provider offering none; empty settings are a
   * session that has not reported yet, so they claim nothing. Settings are
   * compared without their values: a draft shows its own preference. A chat
   * that outranks the writer takes over even when it repeats the list, or the
   * writer's next report would still count as the latest.
   */
  const updateWorkspaceListing = (sessionId: string, patch: ComposerListing) => {
    const target = options.listingTarget?.(sessionId)
    if (!target) return
    if (!patch.configOptions?.length && !patch.availableCommands) return
    const held = options.readWorkspaceListing?.(target)
    if (held && givesWayTo(sessionId, held.sourceSessionId)) return
    const changed: ComposerListing = {
      ...(patch.configOptions?.length &&
      !isDeepStrictEqual(
        settingsOffered(patch.configOptions),
        settingsOffered(held?.listing.configOptions),
      )
        ? { configOptions: patch.configOptions }
        : {}),
      ...(patch.availableCommands &&
      !isDeepStrictEqual(patch.availableCommands, held?.listing.availableCommands)
        ? { availableCommands: patch.availableCommands }
        : {}),
    }
    if (Object.keys(changed).length > 0 || (held && held.sourceSessionId !== sessionId)) {
      publish('composer.listing.updated', { ...target, sourceSessionId: sessionId, ...changed })
    }
  }

  // Like `memorySelections`: with a persisted reader, only what failed to write.
  const memoryListings = new Map<string, ComposerListing>()
  const listingOf = (threadId: string): ComposerListing =>
    memoryListings.get(threadId) ?? options.readThreadListing?.(threadId) ?? {}

  /** What the provider offers one chat: the chat's own, then the workspace's for the next one. */
  const updateListing = (sessionId: string, threadId: string, patch: ComposerListing) => {
    const current = listingOf(threadId)
    // Every ACP session reports its settings on creation, most of them none.
    // A chat that never had any has nothing to say, and says nothing.
    if (patch.configOptions?.length === 0 && current.configOptions === undefined) return
    const merged = ComposerListingSchema.safeParse({ ...current, ...defined(patch) })
    if (!merged.success) return
    if (options.hasSession && !options.hasSession(sessionId)) {
      memoryListings.delete(threadId)
      return
    }
    // Against the row rather than memory, so the next write also names a
    // field whose own write failed.
    const stored = options.readThreadListing
      ? options.readThreadListing(threadId)
      : memoryListings.get(threadId)
    const changed = changedFields(merged.data, stored)
    // The workspace's is checked whatever the chat's says: a crash between
    // the two writes must not leave it behind for good.
    if (Object.keys(changed).length > 0) {
      try {
        options.publishThreadListing?.({ sessionId, threadId }, changed)
        if (options.readThreadListing) memoryListings.delete(threadId)
        else memoryListings.set(threadId, merged.data)
      } catch {
        memoryListings.set(threadId, merged.data)
      }
    }
    updateWorkspaceListing(sessionId, defined(patch))
  }

  // What a probe learned, outside any session. It decides which models are
  // listed and never how a listed one reads: a session describes its models
  // in the agent's own words, and a probe that rewrote them would trade the
  // two wordings back and forth for as long as both kept reporting.
  const fillProfileFromCatalog = (
    providerId: string,
    catalog: {
      agentInfo?: Parameters<ComposerStore['upsertProfile']>[1]['agentInfo']
      promptCapabilities?: Parameters<ComposerStore['upsertProfile']>[1]['promptCapabilities']
      models?: Parameters<typeof modelPatch>[0]
      modes?: Parameters<typeof modePatch>[0]
    },
  ) => {
    const current = store.getProfile(providerId)
    const listed = modelPatch(catalog.models).availableModels
    writeProfile(providerId, {
      ...(catalog.agentInfo ? { agentInfo: catalog.agentInfo } : {}),
      // Unlike the catalogs, the handshake's answer is never stale relative
      // to a session's: every process of the provider gives the same one.
      ...(catalog.promptCapabilities ? { promptCapabilities: catalog.promptCapabilities } : {}),
      // An empty listing is a probe that could not say, not a provider with
      // nothing to offer, and must not empty a catalog that was read.
      ...(listed?.length
        ? { availableModels: relistedModels(listed, current?.availableModels) }
        : {}),
      // No probe can ask an ACP agent for its modes, so a probe's answer only
      // ever fills a gap here.
      ...(current?.availableModes === undefined ? modePatch(catalog.modes) : {}),
    })
  }

  const response = (
    capability:
      | typeof COMPOSER_PREFERENCES_SET_CAPABILITY
      | typeof COMPOSER_MODEL_SET_CAPABILITY
      | typeof COMPOSER_MODE_SET_CAPABILITY
      | typeof COMPOSER_CONFIG_OPTION_SET_CAPABILITY,
    requestId: string,
    { preference, revision }: RevisedPreference,
  ) =>
    ComposerResponseSchemas[capability].parse({
      type: 'response',
      requestId,
      payload: { preference, revision },
    })

  const target = async (requestId: string, sessionId: string, context?: CommandContext) => {
    const pending = resolveSession(sessionId, context)
    if (!pending) return errorResult(requestId, 'not_found', 'Session not found.')
    if (!(pending instanceof Promise)) {
      return errorResult(requestId, pending.code, pending.message, pending.details)
    }
    const resolved = await pending
    const rejection = providers.rejection(resolved.providerId)
    return rejection ? errorResult(requestId, rejection.code, rejection.message) : resolved
  }

  const catalog = () =>
    providers.snapshot().map((provider) => ({
      ...provider,
      ...(store.getProfile(provider.id) ? { profile: store.getProfile(provider.id) } : {}),
    }))

  return {
    /** Cancel pending model lookups' retries. Call before closing the store. */
    stop() {
      stopped = true
      for (const cancel of retries.values()) cancel()
      retries.clear()
    },

    observeProbe(providerId: string, probe: RuntimeProviderBootstrap) {
      try {
        fillProfileFromCatalog(providerId, {
          agentInfo: probe.result.agentInfo,
          promptCapabilities: promptCapabilitiesPatch(probe.result.promptCapabilities),
          models: probe.models,
          modes: probe.modes,
        })
      } catch {
        // A successful provider probe remains successful if its optional
        // composer metadata is malformed or cannot be persisted.
      }
    },

    /**
     * What any probe learned, including the health probes no client asked
     * for. Those are the only ones a provider nobody has opened ever gets, so
     * they are what lets a composer offer it.
     */
    observeCatalog(providerId: string, catalog: RuntimeProviderCatalog) {
      if (stopped) return
      try {
        fillProfileFromCatalog(providerId, {
          agentInfo: catalog.agentInfo,
          promptCapabilities: promptCapabilitiesPatch(catalog.promptCapabilities),
          models: catalog.models,
          modes: catalog.modes,
        })
      } catch {
        // Advisory, as above: the probe that learned this still succeeded.
      }
    },

    /** The selection a client would see for this session right now. */
    sessionComposer: selectionOf,

    /** The listing a client would see for this chat right now. */
    threadListing: listingOf,

    /**
     * A draft's picks, filed by `session.create` before the provider starts,
     * and the preference the new session launches on. The same write as
     * `composer.preferences.set`, so every client's next draft in the
     * workspace follows it.
     */
    launchPreference(
      workspaceId: string,
      providerId: string,
      picks?: WorkspaceComposerPreference,
    ): WorkspaceComposerPreference {
      return picks
        ? writePreference(workspaceId, providerId, picks).preference
        : store.getPreference(workspaceId, providerId)
    },

    /**
     * A new session's own model and config, from the preference it launched
     * on. Written before its provider starts, so the first report seeds
     * nothing over it and a concurrent launch cannot either.
     */
    seedSession(
      sessionId: string,
      selection: Pick<WorkspaceComposerPreference, 'modelId' | 'configValues'>,
    ) {
      updateSelection(sessionId, selection)
    },

    /** A mode the host started a turn in without a `composer.mode.set` (a plan build). */
    recordSessionMode(sessionId: string, modeId: string) {
      try {
        updateSelection(sessionId, { modeId })
      } catch {
        // Display state only; the turn it describes must still start.
      }
    },

    /**
     * What a session's runtime must be configured with before a prompt: the
     * session's own selection, and the workspace preference for whatever the
     * session has not chosen yet.
     */
    desiredFor(args: { providerId: string; workspacePath: string; threadId?: string }) {
      const sessionId = args.threadId ? options.sessionForThread?.(args.threadId) : undefined
      return desiredSessionConfig(
        store.getPreference(args.workspacePath, args.providerId),
        sessionId ? selectionOf(sessionId) : undefined,
      )
    },

    onRuntimeEvent(event: Parameters<HostDeps['emitEvent']>[0]) {
      try {
        if (event.event === 'initialized') {
          // Every process, probe or live session, answers this at handshake;
          // the composer gates image attach on it, so it is recorded from
          // whichever process speaks first and refreshed by each one after.
          const promptCapabilities = promptCapabilitiesPatch(event.data.promptCapabilities)
          writeProfile(event.providerId, {
            ...(event.data.agentInfo ? { agentInfo: event.data.agentInfo } : {}),
            ...(promptCapabilities ? { promptCapabilities } : {}),
          })
          return
        }
        const sessionId = options.sessionForThread?.(event.threadId)
        if (event.event === 'session_created' || event.event === 'session_loaded') {
          if (sessionId) {
            // The first report seeds a session that has no selection yet from
            // the workspace preference; after that the session owns it.
            const current = selectionOf(sessionId)
            const preference = event.workspaceId
              ? store.getPreference(event.workspaceId, event.providerId)
              : {}
            updateSelection(sessionId, {
              modelId: current.modelId ?? preference.modelId ?? event.data.models?.currentModelId,
              modeId: reportedMode(event.event, current.modeId, event.data.modes),
              configValues: current.configValues ?? preference.configValues,
            })
            updateListing(sessionId, event.threadId, {
              configOptions: configOptionsPatch(event.data.configOptions),
            })
          }
          writeProfile(event.providerId, {
            ...modelPatch(event.data.models),
            ...modePatch(event.data.modes),
            ...(event.event === 'session_created' && event.data.models?.currentModelId
              ? { defaultModelId: event.data.models.currentModelId }
              : {}),
            ...(event.event === 'session_created' && event.data.modes?.currentModeId
              ? { defaultModeId: event.data.modes.currentModeId }
              : {}),
          })
          return
        }
        if (event.event === 'current_model_update') {
          const selected = event.workspaceId
            ? store.getPreference(event.workspaceId, event.providerId).modelId
            : undefined
          if (
            event.workspaceId &&
            selected &&
            event.data.currentModelId &&
            event.data.availableModels &&
            !event.data.availableModels.some((model) => model.id === selected)
          ) {
            writePreference(event.workspaceId, event.providerId, {
              modelId: event.data.currentModelId,
            })
          }
          if (sessionId && event.data.currentModelId) {
            // The user's pick is re-applied before every prompt, so a report
            // only replaces one the provider no longer offers.
            const chosen = selectionOf(sessionId).modelId
            const offered = event.data.availableModels
            if (!chosen || (offered && !offered.some((model) => model.id === chosen))) {
              updateSelection(sessionId, { modelId: event.data.currentModelId })
            }
          }
          writeProfile(event.providerId, modelPatch(event.data))
          return
        }
        if (event.event === 'current_mode_update') {
          const selected = event.workspaceId
            ? store.getPreference(event.workspaceId, event.providerId).modeId
            : undefined
          if (
            event.workspaceId &&
            selected &&
            event.data.currentModeId &&
            event.data.availableModes &&
            !event.data.availableModes.some((mode) => mode.id === selected)
          ) {
            writePreference(event.workspaceId, event.providerId, {
              modeId: event.data.currentModeId,
            })
          }
          // The agent switches modes itself (plan to build); every composer follows.
          if (sessionId && event.data.currentModeId) {
            updateSelection(sessionId, { modeId: event.data.currentModeId })
          }
          writeProfile(event.providerId, modePatch(event.data))
          return
        }
        if (event.event === 'config_option_update' && sessionId) {
          updateListing(sessionId, event.threadId, {
            configOptions: configOptionsPatch(event.data.configOptions),
          })
          return
        }
        if (event.event === 'available_commands_update' && sessionId) {
          // The provider lists its commands again whenever a session loads, so
          // an empty listing is a real "none now", not a gap to fill.
          updateListing(sessionId, event.threadId, {
            availableCommands: commandsPatch(event.data.availableCommands),
          })
          return
        }
        if (event.event === 'usage_update' && sessionId) {
          // Providers do not report usage again when a session loads, so the
          // last reading is kept with the selection and survives a restart.
          // One the protocol cannot carry (no window size) leaves it alone.
          const usage = ComposerUsageSchema.safeParse({
            used: Math.round(event.data.used),
            size: Math.round(event.data.size),
            ...(event.data.cost ? { cost: event.data.cost } : {}),
          })
          if (usage.success) updateSelection(sessionId, { usage: usage.data })
        }
      } catch {
        // Provider metadata is advisory. Invalid or unpersistable catalog data
        // must not escape into AgentRuntime's event delivery path.
      }
    },

    dispatch(
      command: CommandEnvelope,
      context?: CommandContext,
    ): unknown | Promise<unknown> | undefined {
      if (command.name === PROVIDER_CATALOG_CAPABILITY) {
        const parsed = ComposerCommandSchemas[PROVIDER_CATALOG_CAPABILITY].safeParse(command)
        if (!parsed.success) {
          return errorResult(command.requestId, 'validation', 'Invalid provider catalog request.')
        }
        return ComposerResponseSchemas[PROVIDER_CATALOG_CAPABILITY].parse({
          type: 'response',
          requestId: command.requestId,
          payload: { providers: catalog() },
        })
      }

      if (command.name === COMPOSER_PREFERENCES_SET_CAPABILITY) {
        const parsed =
          ComposerCommandSchemas[COMPOSER_PREFERENCES_SET_CAPABILITY].safeParse(command)
        if (!parsed.success) {
          return errorResult(command.requestId, 'validation', 'Invalid composer preference update.')
        }
        const { workspaceId, providerId, preference } = parsed.data.payload
        if (!providerExists(providerId)) {
          return errorResult(command.requestId, 'not_found', 'Provider not found.')
        }
        let revised: RevisedPreference
        try {
          revised = writePreference(workspaceId, providerId, preference)
        } catch {
          // Nothing was written, so nothing is answered as saved (I10).
          return errorResult(command.requestId, 'unavailable', PREFERENCE_NOT_SAVED)
        }
        return response(COMPOSER_PREFERENCES_SET_CAPABILITY, command.requestId, revised)
      }

      if (command.name === COMPOSER_MODEL_SET_CAPABILITY) {
        const parsed = ComposerCommandSchemas[COMPOSER_MODEL_SET_CAPABILITY].safeParse(command)
        if (!parsed.success) {
          return errorResult(command.requestId, 'validation', 'Invalid model update.')
        }
        return (async () => {
          const resolved = await target(command.requestId, parsed.data.payload.sessionId, context)
          if ('type' in resolved) return resolved
          await runtime.setModel({ ...resolved, modelId: parsed.data.payload.modelId })
          const selection = updateSelection(parsed.data.payload.sessionId, {
            modelId: parsed.data.payload.modelId,
          })
          // The preference is only "last used": it seeds the next draft and
          // leaves every other session's model alone.
          let revised: RevisedPreference
          try {
            revised = writePreference(resolved.workspaceId ?? resolved.cwd, resolved.providerId, {
              modelId: parsed.data.payload.modelId,
            })
          } catch {
            return errorResult(command.requestId, 'unavailable', PREFERENCE_NOT_SAVED)
          }
          const values = selection.configValues ?? revised.preference.configValues
          if (values) await runtime.applyDesiredConfig(resolved, { values })
          return response(COMPOSER_MODEL_SET_CAPABILITY, command.requestId, revised)
        })()
      }

      if (command.name === COMPOSER_MODE_SET_CAPABILITY) {
        const parsed = ComposerCommandSchemas[COMPOSER_MODE_SET_CAPABILITY].safeParse(command)
        if (!parsed.success) {
          return errorResult(command.requestId, 'validation', 'Invalid mode update.')
        }
        return (async () => {
          const resolved = await target(command.requestId, parsed.data.payload.sessionId, context)
          if ('type' in resolved) return resolved
          await runtime.setMode({ ...resolved, modeId: parsed.data.payload.modeId })
          updateSelection(parsed.data.payload.sessionId, { modeId: parsed.data.payload.modeId })
          let revised: RevisedPreference
          try {
            revised = writePreference(resolved.workspaceId ?? resolved.cwd, resolved.providerId, {
              modeId: parsed.data.payload.modeId,
            })
          } catch {
            return errorResult(command.requestId, 'unavailable', PREFERENCE_NOT_SAVED)
          }
          return response(COMPOSER_MODE_SET_CAPABILITY, command.requestId, revised)
        })()
      }

      if (command.name === COMPOSER_CONFIG_OPTION_SET_CAPABILITY) {
        const parsed =
          ComposerCommandSchemas[COMPOSER_CONFIG_OPTION_SET_CAPABILITY].safeParse(command)
        if (!parsed.success) {
          return errorResult(command.requestId, 'validation', 'Invalid config option update.')
        }
        return (async () => {
          const resolved = await target(command.requestId, parsed.data.payload.sessionId, context)
          if ('type' in resolved) return resolved
          const workspaceId = resolved.workspaceId ?? resolved.cwd
          await runtime.setConfigOption({
            ...resolved,
            configId: parsed.data.payload.configId,
            value: parsed.data.payload.value,
          })
          updateSelection(parsed.data.payload.sessionId, {
            configValues: {
              ...(selectionOf(parsed.data.payload.sessionId).configValues ?? {}),
              [parsed.data.payload.configId]: parsed.data.payload.value,
            },
          })
          const current = store.getPreference(workspaceId, resolved.providerId)
          let revised: RevisedPreference
          try {
            revised = writePreference(workspaceId, resolved.providerId, {
              configValues: {
                ...(current.configValues ?? {}),
                [parsed.data.payload.configId]: parsed.data.payload.value,
              },
            })
          } catch {
            return errorResult(command.requestId, 'unavailable', PREFERENCE_NOT_SAVED)
          }
          return response(COMPOSER_CONFIG_OPTION_SET_CAPABILITY, command.requestId, revised)
        })()
      }

      return undefined
    },
  }
}

export function desiredSessionConfig(
  preference: WorkspaceComposerPreference,
  selection?: SessionComposerState,
): DesiredSessionConfig | undefined {
  const modelId = selection?.modelId ?? preference.modelId
  const values = selection?.configValues ?? preference.configValues
  // Mode comes from the session alone, never the workspace preference, and
  // the runtime applies it only when a process starts. The session's mode
  // follows every switch the agent makes itself (plan to build), so it puts a
  // restarted process back where the session was — without it the process
  // comes back in the provider's default and quietly drops a mode like
  // `bypassPermissions`. The workspace's "last used" mode only seeds drafts:
  // forcing it on every session was what fought those plan/build transitions.
  const modeId = selection?.modeId
  const desired = {
    ...(modelId ? { modelId } : {}),
    ...(modeId ? { modeId } : {}),
    ...(values ? { values } : {}),
  }
  return Object.keys(desired).length > 0 ? desired : undefined
}

/**
 * The mode a session should show after its process reports in.
 *
 * A created session is in whatever the provider says. A *loaded* one is a
 * restarted process reporting the provider's default before the session's own
 * mode is re-applied (ACP applies it after the load event), so taking the
 * report at face value would overwrite a remembered `bypassPermissions` with
 * `default` — for good, if the process dies before the re-apply lands. The
 * remembered mode is kept unless the provider no longer offers it.
 */
function reportedMode(
  event: 'session_created' | 'session_loaded',
  remembered: string | undefined,
  modes: { currentModeId?: string; availableModes?: Array<{ id: string }> } | undefined,
): string | undefined {
  const reported = modes?.currentModeId
  if (event === 'session_created' || remembered === undefined) return reported ?? remembered
  const offered = modes?.availableModes
  if (offered === undefined || offered.some((mode) => mode.id === remembered)) return remembered
  return reported ?? remembered
}

/** Options the protocol cannot carry are dropped, not allowed to hide the rest. */
function configOptionsPatch(
  options: readonly unknown[] | undefined,
): ComposerConfigOption[] | undefined {
  if (options === undefined) return undefined
  return options.flatMap((option) => {
    const parsed = ComposerConfigOptionSchema.safeParse(option)
    return parsed.success ? [parsed.data] : []
  })
}

/** The fields of `next` that differ from `held`, each whole. */
function changedFields(next: ComposerListing, held: ComposerListing | undefined): ComposerListing {
  return {
    ...(next.configOptions && !isDeepStrictEqual(next.configOptions, held?.configOptions)
      ? { configOptions: next.configOptions }
      : {}),
    ...(next.availableCommands &&
    !isDeepStrictEqual(next.availableCommands, held?.availableCommands)
      ? { availableCommands: next.availableCommands }
      : {}),
  }
}

/** Settings as a list of what is on offer, whatever each is set to now. */
const settingsOffered = (options: readonly ComposerConfigOption[] | undefined) =>
  options?.map(({ currentValue: _value, ...offered }) => offered)

/** Same rule for commands: one the protocol cannot carry costs only itself. */
function commandsPatch(
  commands: ReadonlyArray<{
    name: string
    description: string
    input?: { placeholder?: string }
  }>,
): ComposerCommandOption[] {
  return commands
    .flatMap((command) => {
      const parsed = ComposerCommandOptionSchema.safeParse({
        name: command.name,
        description: command.description,
        ...(command.input?.placeholder ? { placeholder: command.input.placeholder } : {}),
      })
      return parsed.success ? [parsed.data] : []
    })
    .slice(0, 1_024)
}

function defined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>
}

function modelPatch(
  models:
    | {
        availableModels?: Array<{
          id: string
          displayName: string
          description?: string
          contextWindowTokens?: number
          effortLevels?: string[]
          supportsFastMode?: boolean
          supportsAutoMode?: boolean
          supportsImageInput?: boolean
          configOptions?: readonly unknown[]
        }>
      }
    | undefined,
) {
  const availableModels = models?.availableModels
  if (availableModels === undefined) return {}
  return {
    availableModels: availableModels.map((model) => ({
      modelId: model.id,
      name: model.displayName,
      ...(model.description !== undefined ? { description: model.description } : {}),
      ...(model.contextWindowTokens !== undefined
        ? { contextWindowTokens: model.contextWindowTokens }
        : {}),
      ...(model.effortLevels?.length ? { effortLevels: model.effortLevels } : {}),
      ...(model.supportsFastMode ? { supportsFastMode: true } : {}),
      ...(model.supportsAutoMode ? { supportsAutoMode: true } : {}),
      // Tri-state, so `false` survives: it is the answer that blocks an attach.
      ...(model.supportsImageInput !== undefined
        ? { supportsImageInput: model.supportsImageInput }
        : {}),
      // Empty survives too: it is a catalog saying this model has no settings.
      ...(model.configOptions !== undefined
        ? { configOptions: configOptionsPatch(model.configOptions)!.slice(0, 64) }
        : {}),
    })),
  }
}

/**
 * The catalog after a probe relisted it: the rows already held, in the order
 * they were held, minus the ones no longer offered, then the new ones.
 *
 * A held row keeps everything it says and takes from the relisting only what
 * it had no answer for. Order is kept for the same reason wording is: two
 * sources that list the same models in different orders would otherwise
 * reshuffle every picker each time either of them reported.
 */
function relistedModels(
  listed: ComposerModelOption[],
  held: ComposerModelOption[] | undefined,
): ComposerModelOption[] {
  if (!held?.length) return listed
  const offered = new Map(listed.map((model) => [model.modelId, model]))
  const kept = held.flatMap((model) => {
    const relisted = offered.get(model.modelId)
    if (!relisted) return []
    // Wording and order stay as held, but the window and the settings are
    // facts only a catalog reports, so a newer catalog's answer replaces them.
    return [
      {
        ...relisted,
        ...model,
        ...(relisted.contextWindowTokens !== undefined
          ? { contextWindowTokens: relisted.contextWindowTokens }
          : {}),
        ...(relisted.configOptions !== undefined ? { configOptions: relisted.configOptions } : {}),
      },
    ]
  })
  const known = new Set(held.map((model) => model.modelId))
  return [...kept, ...listed.filter((model) => !known.has(model.modelId))]
}

/** Rows as relisted, each keeping the image answer, context window and
 * settings its id already had when the relisting says nothing about them. */
function withKnownModelFacts(
  next: ComposerModelOption[],
  previous: ComposerModelOption[] | undefined,
): ComposerModelOption[] {
  if (!previous?.length) return next
  const known = new Map(previous.map((model) => [model.modelId, model]))
  return next.map((model) => {
    const before = known.get(model.modelId)
    if (!before) return model
    const kept = {
      ...(model.supportsImageInput === undefined && before.supportsImageInput !== undefined
        ? { supportsImageInput: before.supportsImageInput }
        : {}),
      ...(model.contextWindowTokens === undefined && before.contextWindowTokens !== undefined
        ? { contextWindowTokens: before.contextWindowTokens }
        : {}),
      ...(model.configOptions === undefined && before.configOptions !== undefined
        ? { configOptions: before.configOptions }
        : {}),
    }
    return Object.keys(kept).length > 0 ? { ...model, ...kept } : model
  })
}

/** The wire triple, or nothing when the runtime had no handshake answer. A
 * Claude probe reports a constant; an ACP one reports what `initialize`
 * said, already normalised so an omitted field is `false`. */
function promptCapabilitiesPatch(
  capabilities: { image?: boolean; audio?: boolean; embeddedContext?: boolean } | undefined,
): PromptCapabilities | undefined {
  if (!capabilities) return undefined
  return {
    image: capabilities.image === true,
    audio: capabilities.audio === true,
    embeddedContext: capabilities.embeddedContext === true,
  }
}

function modePatch(
  modes:
    | {
        availableModes?: Array<{ id: string; displayName: string; description?: string }>
      }
    | undefined,
) {
  const availableModes = modes?.availableModes
  if (availableModes === undefined) return {}
  return {
    availableModes: availableModes.map((mode) => ({
      id: mode.id,
      name: mode.displayName,
      ...(mode.description !== undefined ? { description: mode.description } : {}),
    })),
  }
}
