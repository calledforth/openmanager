import {
  COMPOSER_CONFIG_OPTION_SET_CAPABILITY,
  COMPOSER_MODEL_SET_CAPABILITY,
  COMPOSER_MODE_SET_CAPABILITY,
  COMPOSER_PREFERENCES_GET_CAPABILITY,
  COMPOSER_PREFERENCES_SET_CAPABILITY,
  ComposerCommandSchemas,
  ComposerResponseSchemas,
  PROVIDER_CATALOG_CAPABILITY,
  type CommandEnvelope,
  type ErrorCode,
  type ProviderBootstrap,
} from '@openmanager/protocol/node'
import type {
  AgentRuntime,
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
  | 'providerModels'
  | 'providerModes'
>

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
) {
  const providerExists = (providerId: string) =>
    providers.snapshot().some((provider) => provider.id === providerId)

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

  const catalog = () => {
    for (const [providerId, models] of Object.entries(runtime.providerModels())) {
      if (models) store.upsertProfile(providerId, modelPatch(models))
    }
    for (const [providerId, modes] of Object.entries(runtime.providerModes())) {
      if (modes) store.upsertProfile(providerId, modePatch(modes))
    }
    return providers.snapshot().map((provider) => ({
      ...provider,
      ...(store.getProfile(provider.id) ? { profile: store.getProfile(provider.id) } : {}),
    }))
  }

  return {
    desiredSessionConfig: ({ providerId, workspacePath }: Parameters<
      NonNullable<HostDeps['desiredSessionConfig']>
    >[0]) => store.getPreference(workspacePath, providerId),

    observeProbe(providerId: string, probe: RuntimeProviderBootstrap) {
      store.upsertProfile(providerId, {
        ...(probe.result.agentInfo ? { agentInfo: probe.result.agentInfo } : {}),
        ...modelPatch(probe.models),
        ...modePatch(probe.modes),
      })
    },

    onRuntimeEvent(event: Parameters<HostDeps['emitEvent']>[0]) {
      if (event.event === 'initialized' && event.data.agentInfo) {
        store.upsertProfile(event.providerId, { agentInfo: event.data.agentInfo })
        return
      }
      if (event.event === 'session_created' || event.event === 'session_loaded') {
        store.upsertProfile(event.providerId, {
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
        store.upsertProfile(event.providerId, modelPatch(event.data))
        return
      }
      if (event.event === 'current_mode_update') {
        store.upsertProfile(event.providerId, modePatch(event.data))
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
          store.setPreference(workspaceId, providerId, preference),
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
          const preference = store.setPreference(resolved.workspaceId ?? resolved.cwd, resolved.providerId, {
            modelId: parsed.data.payload.modelId,
          })
          if (preference.configValues) {
            await runtime.applyDesiredConfig(resolved, { values: preference.configValues })
          }
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
          const preference = store.setPreference(resolved.workspaceId ?? resolved.cwd, resolved.providerId, {
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
          const current = store.getPreference(workspaceId, resolved.providerId)
          const preference = store.setPreference(workspaceId, resolved.providerId, {
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
  if (!availableModels?.length) return {}
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
  if (!availableModes?.length) return {}
  return {
    availableModes: availableModes.map((mode) => ({
      id: mode.id,
      name: mode.displayName,
      ...(mode.description !== undefined ? { description: mode.description } : {}),
    })),
  }
}
