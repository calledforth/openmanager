import { isDeepStrictEqual } from 'node:util'
import {
  COMPOSER_CONFIG_OPTION_SET_CAPABILITY,
  COMPOSER_MODEL_SET_CAPABILITY,
  COMPOSER_MODE_SET_CAPABILITY,
  COMPOSER_PREFERENCES_GET_CAPABILITY,
  COMPOSER_PREFERENCES_SET_CAPABILITY,
  ComposerCommandSchemas,
  ComposerConfigOptionSchema,
  ComposerResponseSchemas,
  PROVIDER_CATALOG_CAPABILITY,
  SessionComposerStateSchema,
  type CommandEnvelope,
  type ComposerConfigOption,
  type ErrorCode,
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
  RuntimeRoute,
} from '@agentpack/runtime/node'
import type { ComposerStore } from './composer-store.ts'

type RuntimeTarget = RuntimeRoute & { sessionId: string }
type ResolveSession = (sessionId: string) => Promise<RuntimeTarget> | undefined
type ProviderSource = {
  snapshot(): ProviderBootstrap[]
  rejection(providerId: string): { code: ErrorCode; message: string } | undefined
}
type RuntimeControl = Pick<
  AgentRuntime,
  | 'setModel'
  | 'setMode'
  | 'setConfigOption'
  | 'applyDesiredConfig'
>

type ComposerEventName =
  | 'session.composer.updated'
  | 'composer.preferences.updated'
  | 'provider.catalog.updated'
type ComposerEventPayload<N extends ComposerEventName> = Extract<ProofEvent, { name: N }>['payload']

export interface ComposerServiceOptions {
  /**
   * Broadcast a change to every client. The host wraps the payload in a
   * durable environment event, so a reconnecting client replays it. Without a
   * publisher the service still tracks state, for tests and offline hosts.
   */
  publish?: <N extends ComposerEventName>(name: N, payload: ComposerEventPayload<N>) => void
  /** The host session that owns a runtime thread; probes and unknown threads have none. */
  sessionForThread?: (threadId: string) => string | undefined
  /** The session's persisted selection. Without it selections live in memory. */
  readSessionComposer?: (sessionId: string) => SessionComposerState | undefined
}

const errorResult = (requestId: string, code: ErrorCode, message: string) => ({
  type: 'error' as const,
  requestId,
  error: { code, message },
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

  // Broadcasting is advisory: the write it describes has already happened, and
  // a payload the protocol rejects (a workspace keyed by a path with spaces)
  // must fail neither the command nor the runtime's event delivery.
  const publish: NonNullable<ComposerServiceOptions['publish']> = (name, payload) => {
    try {
      options.publish?.(name, payload)
    } catch {
      // Clients converge on their next catalog or preference read.
    }
  }

  const writeProfile = (
    providerId: string,
    patch: Parameters<ComposerStore['upsertProfile']>[1],
  ) => {
    if (Object.keys(patch).length === 0) return
    const before = store.getProfile(providerId)
    const profile = store.upsertProfile(providerId, patch)
    if (profile.updatedAt !== before?.updatedAt) publish('provider.catalog.updated', { profile })
  }

  const writePreference = (
    workspaceId: string,
    providerId: string,
    patch: Parameters<ComposerStore['setPreference']>[2],
  ) => {
    const before = store.getPreference(workspaceId, providerId)
    const preference = store.setPreference(workspaceId, providerId, patch)
    if (!isDeepStrictEqual(before, preference)) {
      publish('composer.preferences.updated', { workspaceId, providerId, preference })
    }
    return preference
  }

  const memorySelections = new Map<string, SessionComposerState>()
  const selectionOf = (sessionId: string): SessionComposerState =>
    (options.readSessionComposer
      ? options.readSessionComposer(sessionId)
      : memorySelections.get(sessionId)) ?? {}

  /**
   * A session's selection is its own: changing it never reaches a sibling
   * session in the same workspace. The publisher persists it with the event.
   */
  const updateSelection = (sessionId: string, patch: Partial<SessionComposerState>) => {
    const current = selectionOf(sessionId)
    const merged = SessionComposerStateSchema.safeParse({ ...current, ...defined(patch) })
    if (!merged.success || isDeepStrictEqual(merged.data, current)) return current
    if (!options.readSessionComposer) memorySelections.set(sessionId, merged.data)
    publish('session.composer.updated', { sessionId, composer: merged.data })
    return merged.data
  }

  // Probe catalogs are fallback metadata. Once a live session has reported a
  // catalog, keep that exact process view instead of replacing it with a probe.
  const fillProfileFromCatalog = (
    providerId: string,
    catalog: {
      agentInfo?: Parameters<ComposerStore['upsertProfile']>[1]['agentInfo']
      models?: Parameters<typeof modelPatch>[0]
      modes?: Parameters<typeof modePatch>[0]
    },
  ) => {
    const current = store.getProfile(providerId)
    writeProfile(providerId, {
      ...(catalog.agentInfo ? { agentInfo: catalog.agentInfo } : {}),
      ...(current?.availableModels === undefined ? modelPatch(catalog.models) : {}),
      ...(current?.availableModes === undefined ? modePatch(catalog.modes) : {}),
    })
  }

  const response = (
    capability:
      | typeof COMPOSER_PREFERENCES_GET_CAPABILITY
      | typeof COMPOSER_PREFERENCES_SET_CAPABILITY
      | typeof COMPOSER_MODEL_SET_CAPABILITY
      | typeof COMPOSER_MODE_SET_CAPABILITY
      | typeof COMPOSER_CONFIG_OPTION_SET_CAPABILITY,
    requestId: string,
    preference: ReturnType<ComposerStore['getPreference']>,
  ) => ComposerResponseSchemas[capability].parse({ type: 'response', requestId, payload: { preference } })

  const target = async (requestId: string, sessionId: string) => {
    const pending = resolveSession(sessionId)
    if (!pending) return errorResult(requestId, 'not_found', 'Session not found.')
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
    observeProbe(providerId: string, probe: RuntimeProviderBootstrap) {
      try {
        fillProfileFromCatalog(providerId, {
          agentInfo: probe.result.agentInfo,
          models: probe.models,
          modes: probe.modes,
        })
      } catch {
        // A successful provider probe remains successful if its optional
        // composer metadata is malformed or cannot be persisted.
      }
    },

    /** The selection a client would see for this session right now. */
    sessionComposer: selectionOf,

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
        if (event.event === 'initialized' && event.data.agentInfo) {
          writeProfile(event.providerId, { agentInfo: event.data.agentInfo })
          return
        }
        const sessionId = options.sessionForThread?.(event.threadId)
        if (event.event === 'session_created' || event.event === 'session_loaded') {
          if (sessionId) {
            // The first report seeds a session that has no selection yet from
            // the workspace preference; after that the session owns it. Mode is
            // the exception: the provider's live mode always wins.
            const current = selectionOf(sessionId)
            const preference = event.workspaceId
              ? store.getPreference(event.workspaceId, event.providerId)
              : {}
            updateSelection(sessionId, {
              modelId: current.modelId ?? preference.modelId ?? event.data.models?.currentModelId,
              modeId: event.data.modes?.currentModeId ?? current.modeId,
              configValues: current.configValues ?? preference.configValues,
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
          updateSelection(sessionId, {
            configOptions: configOptionsPatch(event.data.configOptions),
          })
        }
      } catch {
        // Provider metadata is advisory. Invalid or unpersistable catalog data
        // must not escape into AgentRuntime's event delivery path.
      }
    },

    dispatch(command: CommandEnvelope): unknown | Promise<unknown> | undefined {
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

      if (command.name === COMPOSER_PREFERENCES_GET_CAPABILITY) {
        const parsed = ComposerCommandSchemas[COMPOSER_PREFERENCES_GET_CAPABILITY].safeParse(command)
        if (!parsed.success) {
          return errorResult(command.requestId, 'validation', 'Invalid composer preference request.')
        }
        const { workspaceId, providerId } = parsed.data.payload
        if (!providerExists(providerId)) {
          return errorResult(command.requestId, 'not_found', 'Provider not found.')
        }
        return response(
          COMPOSER_PREFERENCES_GET_CAPABILITY,
          command.requestId,
          store.getPreference(workspaceId, providerId),
        )
      }

      if (command.name === COMPOSER_PREFERENCES_SET_CAPABILITY) {
        const parsed = ComposerCommandSchemas[COMPOSER_PREFERENCES_SET_CAPABILITY].safeParse(command)
        if (!parsed.success) {
          return errorResult(command.requestId, 'validation', 'Invalid composer preference update.')
        }
        const { workspaceId, providerId, preference } = parsed.data.payload
        if (!providerExists(providerId)) {
          return errorResult(command.requestId, 'not_found', 'Provider not found.')
        }
        return response(
          COMPOSER_PREFERENCES_SET_CAPABILITY,
          command.requestId,
          writePreference(workspaceId, providerId, preference),
        )
      }

      if (command.name === COMPOSER_MODEL_SET_CAPABILITY) {
        const parsed = ComposerCommandSchemas[COMPOSER_MODEL_SET_CAPABILITY].safeParse(command)
        if (!parsed.success) {
          return errorResult(command.requestId, 'validation', 'Invalid model update.')
        }
        return (async () => {
          const resolved = await target(command.requestId, parsed.data.payload.sessionId)
          if ('type' in resolved) return resolved
          await runtime.setModel({ ...resolved, modelId: parsed.data.payload.modelId })
          const selection = updateSelection(parsed.data.payload.sessionId, {
            modelId: parsed.data.payload.modelId,
          })
          // The preference is only "last used": it seeds the next draft and
          // leaves every other session's model alone.
          const preference = writePreference(resolved.workspaceId ?? resolved.cwd, resolved.providerId, {
            modelId: parsed.data.payload.modelId,
          })
          const values = selection.configValues ?? preference.configValues
          if (values) await runtime.applyDesiredConfig(resolved, { values })
          return response(COMPOSER_MODEL_SET_CAPABILITY, command.requestId, preference)
        })()
      }

      if (command.name === COMPOSER_MODE_SET_CAPABILITY) {
        const parsed = ComposerCommandSchemas[COMPOSER_MODE_SET_CAPABILITY].safeParse(command)
        if (!parsed.success) {
          return errorResult(command.requestId, 'validation', 'Invalid mode update.')
        }
        return (async () => {
          const resolved = await target(command.requestId, parsed.data.payload.sessionId)
          if ('type' in resolved) return resolved
          await runtime.setMode({ ...resolved, modeId: parsed.data.payload.modeId })
          updateSelection(parsed.data.payload.sessionId, { modeId: parsed.data.payload.modeId })
          const preference = writePreference(resolved.workspaceId ?? resolved.cwd, resolved.providerId, {
            modeId: parsed.data.payload.modeId,
          })
          return response(COMPOSER_MODE_SET_CAPABILITY, command.requestId, preference)
        })()
      }

      if (command.name === COMPOSER_CONFIG_OPTION_SET_CAPABILITY) {
        const parsed =
          ComposerCommandSchemas[COMPOSER_CONFIG_OPTION_SET_CAPABILITY].safeParse(command)
        if (!parsed.success) {
          return errorResult(command.requestId, 'validation', 'Invalid config option update.')
        }
        return (async () => {
          const resolved = await target(command.requestId, parsed.data.payload.sessionId)
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
          const preference = writePreference(workspaceId, resolved.providerId, {
            configValues: {
              ...(current.configValues ?? {}),
              [parsed.data.payload.configId]: parsed.data.payload.value,
            },
          })
          return response(COMPOSER_CONFIG_OPTION_SET_CAPABILITY, command.requestId, preference)
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
  // Mode is persisted for composer display but deliberately not enforced on
  // respawn: doing so can fight the provider's plan/execute mode transitions.
  const modelId = selection?.modelId ?? preference.modelId
  const values = selection?.configValues ?? preference.configValues
  const desired = {
    ...(modelId ? { modelId } : {}),
    ...(values ? { values } : {}),
  }
  return Object.keys(desired).length > 0 ? desired : undefined
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

function defined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>
}

function modelPatch(models: {
  availableModels?: Array<{
    id: string
    displayName: string
    description?: string
    contextWindowTokens?: number
    effortLevels?: string[]
    supportsFastMode?: boolean
    supportsAutoMode?: boolean
  }>
} | undefined) {
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
    })),
  }
}

function modePatch(modes: {
  availableModes?: Array<{ id: string; displayName: string; description?: string }>
} | undefined) {
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
