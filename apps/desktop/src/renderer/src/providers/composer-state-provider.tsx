import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api } from '@openmanager/convex/_generated/api'
import type { ProviderId, SessionConfigOption } from '@agentpack/contract'
import {
  composerPreferencesFromDocs,
  composerProfilesFromDocs,
  mergeProviderComposerProfiles,
  mergeWorkspaceComposerPreferences,
  withProviderCatalog,
  workspaceComposerPreferenceKey,
  type ProviderComposerProfile,
  type ProviderComposerProfiles,
  type ProviderComposerProfileDoc,
  type WorkspaceComposerPreference,
  type WorkspaceComposerPreferences,
  type WorkspaceComposerPreferenceDoc,
} from '@openmanager/shared/contracts/composer-profile'
import {
  updateSessionConfigOptions,
  type SessionConfigValue,
} from '@openmanager/app-core/components/chat/modelConfig'
import {
  CHROME_EVENT_TYPES,
  ComposerStateContext,
  resolveDraftComposerRuntime,
  resolveSessionComposerRuntime,
  toAcpModels,
  toAcpModes,
  type AcpCommandOption,
  type AcpSessionRuntimeState,
  type ComposerStateValue,
  type DraftComposerSelection,
} from '@openmanager/app-core/providers/composer-provider'
import { usePlatformCapabilities } from '@openmanager/app-core/providers/platform-provider'
import { useSessionState } from '@openmanager/app-core/providers/session-provider'
import { trackedConvexQuery, useTrackedMutation, useTrackedQuery } from '../lib/convex-telemetry'
import { resolveSessionProviderId, sessionsForProvider } from './session-provider'
export * from '@openmanager/app-core/providers/composer-provider'

type AgentEventList = ComposerStateValue['agentEvents']
type DraftRuntime = Partial<Omit<AcpSessionRuntimeState, 'sessionId'>>

/** Host-backed composer selection: live per-session runtime from ACP events,
 * per-provider profiles and per-workspace preferences persisted through the
 * main process and mirrored to Convex. */
export function ComposerStateProvider({ children }: { children: ReactNode }) {
  const { providers, ensureProvider, currentClientId } = usePlatformCapabilities()
  const {
    activeWorkspacePath,
    activeSessionId,
    isSessionDraftOpen,
    defaultProviderId,
    setDefaultProviderId,
    draftRequest,
    providerIdForSession,
  } = useSessionState()

  const [acpSessionStateById, setAcpSessionStateById] = useState<
    Record<string, AcpSessionRuntimeState>
  >({})
  const [draftSessionStateByWorkspace, setDraftSessionStateByWorkspace] = useState<
    Record<string, DraftRuntime>
  >({})
  const [draftSelectionByWorkspace, setDraftSelectionByWorkspace] = useState<
    Record<string, DraftComposerSelection>
  >({})
  const [providerComposerProfiles, setProviderComposerProfiles] =
    useState<ProviderComposerProfiles>({})
  const [workspaceComposerPreferences, setWorkspaceComposerPreferences] =
    useState<WorkspaceComposerPreferences>({})
  const [agentEvents, setAgentEvents] = useState<AgentEventList>([])
  const [error, setError] = useState<string | null>(null)

  // Refs mirror state for the callbacks that run outside React's render: IPC
  // events, job submission and the draft seed. Reading state there would
  // capture whatever the value was when the callback was built — which, for
  // a catalog that arrives on the first probe, is empty.
  const providerComposerProfilesRef = useRef<ProviderComposerProfiles>({})
  const workspaceComposerPreferencesRef = useRef<WorkspaceComposerPreferences>({})
  const providersRef = useRef(providers)
  const acpSessionStateByIdRef = useRef(acpSessionStateById)
  const draftSessionStateByWorkspaceRef = useRef(draftSessionStateByWorkspace)
  const draftSelectionByWorkspaceRef = useRef(draftSelectionByWorkspace)
  const defaultProviderIdRef = useRef(defaultProviderId)
  useEffect(() => {
    providersRef.current = providers
  }, [providers])
  useEffect(() => {
    acpSessionStateByIdRef.current = acpSessionStateById
  }, [acpSessionStateById])
  useEffect(() => {
    draftSessionStateByWorkspaceRef.current = draftSessionStateByWorkspace
  }, [draftSessionStateByWorkspace])
  useEffect(() => {
    draftSelectionByWorkspaceRef.current = draftSelectionByWorkspace
  }, [draftSelectionByWorkspace])
  useEffect(() => {
    defaultProviderIdRef.current = defaultProviderId
  }, [defaultProviderId])

  /** The remembered composer profile, backed by the provider's handshake
   * catalog. Every `resolve*ComposerRuntime` caller goes through this or its
   * render-time twin: validating a remembered pick against a catalog the
   * provider never got to report is what silently discarded it. */
  const composerProfileForRef = useCallback(
    (providerId: ProviderId) =>
      withProviderCatalog(
        providerComposerProfilesRef.current[providerId],
        providersRef.current.find((provider) => provider.id === providerId),
      ),
    [],
  )

  const mergeDraftRuntimeForWorkspace = useCallback(
    (
      workspacePath: string,
      patch: {
        providerId?: ProviderId
        models?: AcpSessionRuntimeState['models']
        modes?: AcpSessionRuntimeState['modes']
        configOptions?: SessionConfigOption[]
        availableCommands?: AcpCommandOption[]
      },
    ) => {
      setDraftSessionStateByWorkspace((prev) => ({
        ...prev,
        [workspacePath]: {
          ...(prev[workspacePath] ?? {}),
          ...(patch.providerId ? { providerId: patch.providerId } : {}),
          ...(patch.models ? { models: patch.models } : {}),
          ...(patch.modes ? { modes: patch.modes } : {}),
          ...(patch.configOptions ? { configOptions: patch.configOptions } : {}),
          ...(patch.availableCommands ? { availableCommands: patch.availableCommands } : {}),
        },
      }))
    },
    [],
  )

  const upsertComposerPreference = useTrackedMutation(
    'composer.upsertPreference',
    (api as any).composer.upsertPreference,
  )
  const telemetryContext = useCallback(
    () => ({
      sessionExternalId: activeSessionId ?? undefined,
      workspacePath: activeWorkspacePath ?? undefined,
    }),
    [activeSessionId, activeWorkspacePath],
  )
  const submitJob = useTrackedMutation('jobs.submit', api.jobs.submit, telemetryContext)

  const rememberWorkspaceComposerPreference = useCallback(
    (
      workspacePath: string,
      providerId: ProviderId,
      patch: WorkspaceComposerPreference,
      overwrite = true,
    ) => {
      const key = workspaceComposerPreferenceKey(workspacePath, providerId)
      const current = workspaceComposerPreferencesRef.current[key] ?? {}
      const preference = overwrite ? { ...current, ...patch } : { ...patch, ...current }
      const next = {
        ...workspaceComposerPreferencesRef.current,
        [key]: preference,
      }
      workspaceComposerPreferencesRef.current = next
      setWorkspaceComposerPreferences(next)
      window.electronAPI
        .setWorkspaceComposerPreference(workspacePath, providerId, preference)
        .catch(() => undefined)
      // Mirror to Convex so other devices (mobile) can read composer prefs.
      void upsertComposerPreference({
        workspacePath,
        providerId,
        ...(preference.modelId !== undefined ? { modelId: preference.modelId } : {}),
        ...(preference.modeId !== undefined ? { modeId: preference.modeId } : {}),
        ...(preference.configValues !== undefined ? { configValues: preference.configValues } : {}),
      }).catch(() => undefined)
    },
    [upsertComposerPreference],
  )

  const rememberWorkspaceConfigValue = useCallback(
    (
      workspacePath: string,
      providerId: ProviderId,
      configId: string,
      value: SessionConfigValue,
    ) => {
      const key = workspaceComposerPreferenceKey(workspacePath, providerId)
      const current = workspaceComposerPreferencesRef.current[key]
      rememberWorkspaceComposerPreference(workspacePath, providerId, {
        configValues: {
          ...(current?.configValues ?? {}),
          [configId]: value,
        },
      })
    },
    [rememberWorkspaceComposerPreference],
  )

  const updateProviderComposerProfile = useCallback(
    (providerId: ProviderId, patch: Omit<Partial<ProviderComposerProfile>, 'updatedAt'>) => {
      const current = providerComposerProfilesRef.current[providerId]
      const profile: ProviderComposerProfile = {
        ...(current ?? { updatedAt: Date.now() }),
        ...patch,
        updatedAt: Date.now(),
      }
      const next = {
        ...providerComposerProfilesRef.current,
        [providerId]: profile,
      }
      providerComposerProfilesRef.current = next
      setProviderComposerProfiles(next)
      window.electronAPI.setProviderComposerProfile(providerId, profile).catch(() => undefined)
    },
    [],
  )

  // Seed the draft for a workspace whenever the session provider opens one:
  // inherit the previous session's provider and selection when there was one,
  // otherwise the workspace's last draft pick, otherwise the default provider.
  // Then start that provider and, if no live runtime is known yet, pull the
  // catalog from the workspace's most recent session for that provider.
  useEffect(() => {
    if (!draftRequest) return
    const { workspacePath, previousSessionId } = draftRequest
    let cancelled = false
    const fallbackSessionState = previousSessionId
      ? (acpSessionStateByIdRef.current[previousSessionId] ?? null)
      : null
    const draftProviderId =
      fallbackSessionState?.providerId ??
      draftSelectionByWorkspaceRef.current[workspacePath]?.providerId ??
      defaultProviderIdRef.current
    const preference =
      workspaceComposerPreferencesRef.current[
        workspaceComposerPreferenceKey(workspacePath, draftProviderId)
      ]
    const resolvedDraft = resolveDraftComposerRuntime({
      workspacePath,
      providerId: draftProviderId,
      runtime: fallbackSessionState ?? draftSessionStateByWorkspaceRef.current[workspacePath],
      selection: {
        ...draftSelectionByWorkspaceRef.current[workspacePath],
        ...(fallbackSessionState?.models?.currentModelId
          ? { modelId: fallbackSessionState.models.currentModelId }
          : {}),
        ...(fallbackSessionState?.modes?.currentModeId
          ? { modeId: fallbackSessionState.modes.currentModeId }
          : {}),
      },
      preference,
      profile: composerProfileForRef(draftProviderId),
    })
    setDraftSelectionByWorkspace((prev) => ({
      ...prev,
      [workspacePath]: {
        providerId: draftProviderId,
        ...(resolvedDraft.models?.currentModelId
          ? { modelId: resolvedDraft.models.currentModelId }
          : {}),
        ...(resolvedDraft.modes?.currentModeId
          ? { modeId: resolvedDraft.modes.currentModeId }
          : {}),
      },
    }))
    mergeDraftRuntimeForWorkspace(workspacePath, {
      providerId: draftProviderId,
      ...(resolvedDraft.configOptions ? { configOptions: resolvedDraft.configOptions } : {}),
      ...(resolvedDraft.models ? { models: resolvedDraft.models } : {}),
      ...(resolvedDraft.modes ? { modes: resolvedDraft.modes } : {}),
      ...(resolvedDraft.availableCommands
        ? { availableCommands: resolvedDraft.availableCommands }
        : {}),
    })

    const hasRuntime =
      !!fallbackSessionState?.models?.availableModels?.length ||
      !!fallbackSessionState?.modes?.availableModes?.length ||
      !!fallbackSessionState?.availableCommands?.length
    void (async () => {
      const providerReady = await ensureProvider(draftProviderId, workspacePath)
      if (cancelled || hasRuntime || typeof window.electronAPI.loadAcpSession !== 'function') return
      try {
        const sessions = (await trackedConvexQuery(
          'sessions.listByWorkspace',
          api.sessions.listByWorkspace,
          { workspacePath },
        )) as Array<{ externalId: string; updatedAt: number; providerId?: unknown }>
        if (cancelled) return
        const sorted = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)
        const providerSessions = sessionsForProvider(sorted, draftProviderId)
        const hydrated = providerSessions.find(
          (row) => !!acpSessionStateByIdRef.current[row.externalId],
        )
        if (hydrated) {
          const runtime = acpSessionStateByIdRef.current[hydrated.externalId]
          if (runtime) {
            mergeDraftRuntimeForWorkspace(workspacePath, {
              ...(runtime.configOptions ? { configOptions: runtime.configOptions } : {}),
              ...(runtime.models ? { models: runtime.models } : {}),
              ...(runtime.modes ? { modes: runtime.modes } : {}),
              ...(runtime.availableCommands
                ? { availableCommands: runtime.availableCommands }
                : {}),
            })
          }
          return
        }
        if (providerReady && providerSessions[0]?.externalId) {
          const sessionId = providerSessions[0].externalId
          const providerId = resolveSessionProviderId(providerSessions[0].providerId)
          await window.electronAPI.loadAcpSession(providerId, workspacePath, sessionId)
        }
      } catch {
        // Best-effort hydration; draft can still proceed without metadata.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [composerProfileForRef, draftRequest, ensureProvider, mergeDraftRuntimeForWorkspace])

  const setDraftModel = useCallback(
    (modelId: string) => {
      if (!activeWorkspacePath) return
      const providerId =
        draftSelectionByWorkspace[activeWorkspacePath]?.providerId ?? defaultProviderId
      rememberWorkspaceComposerPreference(activeWorkspacePath, providerId, { modelId })
      setDraftSelectionByWorkspace((prev) => ({
        ...prev,
        [activeWorkspacePath]: { ...(prev[activeWorkspacePath] ?? {}), modelId },
      }))
      setDraftSessionStateByWorkspace((prev) => ({
        ...prev,
        [activeWorkspacePath]: {
          ...(prev[activeWorkspacePath] ?? {}),
          models: { ...(prev[activeWorkspacePath]?.models ?? {}), currentModelId: modelId },
        },
      }))
    },
    [
      activeWorkspacePath,
      defaultProviderId,
      draftSelectionByWorkspace,
      rememberWorkspaceComposerPreference,
    ],
  )

  const setDraftMode = useCallback(
    (modeId: string) => {
      if (!activeWorkspacePath) return
      const providerId =
        draftSelectionByWorkspace[activeWorkspacePath]?.providerId ?? defaultProviderId
      rememberWorkspaceComposerPreference(activeWorkspacePath, providerId, { modeId })
      setDraftSelectionByWorkspace((prev) => ({
        ...prev,
        [activeWorkspacePath]: { ...(prev[activeWorkspacePath] ?? {}), modeId },
      }))
      setDraftSessionStateByWorkspace((prev) => ({
        ...prev,
        [activeWorkspacePath]: {
          ...(prev[activeWorkspacePath] ?? {}),
          modes: { ...(prev[activeWorkspacePath]?.modes ?? {}), currentModeId: modeId },
        },
      }))
    },
    [
      activeWorkspacePath,
      defaultProviderId,
      draftSelectionByWorkspace,
      rememberWorkspaceComposerPreference,
    ],
  )

  const setDraftConfigOption = useCallback(
    (configId: string, value: SessionConfigValue) => {
      if (!activeWorkspacePath) return
      const providerId =
        draftSelectionByWorkspace[activeWorkspacePath]?.providerId ?? defaultProviderId
      rememberWorkspaceConfigValue(activeWorkspacePath, providerId, configId, value)
      setDraftSessionStateByWorkspace((prev) => {
        const current = prev[activeWorkspacePath]
        return {
          ...prev,
          [activeWorkspacePath]: {
            ...(current ?? {}),
            configOptions: updateSessionConfigOptions(current?.configOptions, configId, value),
          },
        }
      })
    },
    [
      activeWorkspacePath,
      defaultProviderId,
      draftSelectionByWorkspace,
      rememberWorkspaceConfigValue,
    ],
  )

  const setDraftProvider = useCallback(
    (providerId: ProviderId, modelId?: string) => {
      if (!activeWorkspacePath) return
      setDefaultProviderId(providerId)
      if (modelId) {
        rememberWorkspaceComposerPreference(activeWorkspacePath, providerId, { modelId })
      }
      const workspaceRuntime = draftSessionStateByWorkspace[activeWorkspacePath]
      const resolvedDraft = resolveDraftComposerRuntime({
        workspacePath: activeWorkspacePath,
        providerId,
        runtime: workspaceRuntime?.providerId === providerId ? workspaceRuntime : undefined,
        selection: modelId ? { providerId, modelId } : undefined,
        preference:
          workspaceComposerPreferencesRef.current[
            workspaceComposerPreferenceKey(activeWorkspacePath, providerId)
          ],
        profile: composerProfileForRef(providerId),
      })
      const nextModelId = modelId ?? resolvedDraft.models?.currentModelId
      setDraftSelectionByWorkspace((prev) => ({
        ...prev,
        [activeWorkspacePath]: {
          providerId,
          ...(nextModelId ? { modelId: nextModelId } : {}),
          ...(resolvedDraft.modes?.currentModeId
            ? { modeId: resolvedDraft.modes.currentModeId }
            : {}),
        },
      }))
      setDraftSessionStateByWorkspace((prev) => ({
        ...prev,
        [activeWorkspacePath]: {
          providerId,
          ...(resolvedDraft.configOptions ? { configOptions: resolvedDraft.configOptions } : {}),
          ...(resolvedDraft.models || nextModelId
            ? {
                models: {
                  ...(resolvedDraft.models ?? {}),
                  ...(nextModelId ? { currentModelId: nextModelId } : {}),
                },
              }
            : {}),
          ...(resolvedDraft.modes ? { modes: resolvedDraft.modes } : {}),
          ...(resolvedDraft.availableCommands
            ? { availableCommands: resolvedDraft.availableCommands }
            : {}),
        },
      }))
      void ensureProvider(providerId, activeWorkspacePath)
    },
    [
      activeWorkspacePath,
      composerProfileForRef,
      draftSessionStateByWorkspace,
      ensureProvider,
      rememberWorkspaceComposerPreference,
      setDefaultProviderId,
    ],
  )

  const recordSessionMode = useCallback(
    (sessionExternalId: string, modeId: string) => {
      setAcpSessionStateById((prev) => ({
        ...prev,
        [sessionExternalId]: {
          ...(prev[sessionExternalId] ?? {
            sessionId: sessionExternalId,
            providerId: providerIdForSession(sessionExternalId),
          }),
          modes: { ...(prev[sessionExternalId]?.modes ?? {}), currentModeId: modeId },
        },
      }))
    },
    [providerIdForSession],
  )

  const setSessionModel = useCallback(
    async (sessionExternalId: string, modelId: string) => {
      if (!activeWorkspacePath || !currentClientId) return
      const providerId = providerIdForSession(sessionExternalId)
      try {
        await submitJob({
          workspacePath: activeWorkspacePath,
          type: 'set_model',
          payload: JSON.stringify({
            workspacePath: activeWorkspacePath,
            sessionExternalId,
            modelId,
            providerId,
          }),
          clientId: currentClientId,
          sessionExternalId,
        })
        setAcpSessionStateById((prev) => ({
          ...prev,
          [sessionExternalId]: {
            ...(prev[sessionExternalId] ?? { sessionId: sessionExternalId, providerId }),
            models: { ...(prev[sessionExternalId]?.models ?? {}), currentModelId: modelId },
          },
        }))
        setDraftSelectionByWorkspace((prev) => ({
          ...prev,
          [activeWorkspacePath]: { ...(prev[activeWorkspacePath] ?? {}), modelId },
        }))
        rememberWorkspaceComposerPreference(activeWorkspacePath, providerId, { modelId })
        setDraftSessionStateByWorkspace((prev) => ({
          ...prev,
          [activeWorkspacePath]: {
            ...(prev[activeWorkspacePath] ?? {}),
            models: { ...(prev[activeWorkspacePath]?.models ?? {}), currentModelId: modelId },
          },
        }))
      } catch (err) {
        setError((err as Error).message)
      }
    },
    [
      activeWorkspacePath,
      currentClientId,
      providerIdForSession,
      rememberWorkspaceComposerPreference,
      submitJob,
    ],
  )

  const setSessionMode = useCallback(
    async (sessionExternalId: string, modeId: string) => {
      if (!activeWorkspacePath || !currentClientId) return
      const providerId = providerIdForSession(sessionExternalId)
      try {
        await submitJob({
          workspacePath: activeWorkspacePath,
          type: 'set_mode',
          payload: JSON.stringify({
            workspacePath: activeWorkspacePath,
            sessionExternalId,
            modeId,
            providerId,
          }),
          clientId: currentClientId,
          sessionExternalId,
        })
        setAcpSessionStateById((prev) => ({
          ...prev,
          [sessionExternalId]: {
            ...(prev[sessionExternalId] ?? { sessionId: sessionExternalId, providerId }),
            modes: { ...(prev[sessionExternalId]?.modes ?? {}), currentModeId: modeId },
          },
        }))
        setDraftSelectionByWorkspace((prev) => ({
          ...prev,
          [activeWorkspacePath]: { ...(prev[activeWorkspacePath] ?? {}), modeId },
        }))
        rememberWorkspaceComposerPreference(activeWorkspacePath, providerId, { modeId })
        setDraftSessionStateByWorkspace((prev) => ({
          ...prev,
          [activeWorkspacePath]: {
            ...(prev[activeWorkspacePath] ?? {}),
            modes: { ...(prev[activeWorkspacePath]?.modes ?? {}), currentModeId: modeId },
          },
        }))
      } catch (err) {
        setError((err as Error).message)
      }
    },
    [
      activeWorkspacePath,
      currentClientId,
      providerIdForSession,
      rememberWorkspaceComposerPreference,
      submitJob,
    ],
  )

  const setSessionConfigOption = useCallback(
    async (sessionExternalId: string, configId: string, value: SessionConfigValue) => {
      if (!activeWorkspacePath || !currentClientId) return
      const providerId = providerIdForSession(sessionExternalId)
      try {
        await submitJob({
          workspacePath: activeWorkspacePath,
          type: 'set_config_option',
          payload: JSON.stringify({
            workspacePath: activeWorkspacePath,
            sessionExternalId,
            configId,
            value,
            providerId,
          }),
          clientId: currentClientId,
          sessionExternalId,
        })
        rememberWorkspaceConfigValue(activeWorkspacePath, providerId, configId, value)
        setAcpSessionStateById((prev) => {
          const current = prev[sessionExternalId]
          return {
            ...prev,
            [sessionExternalId]: {
              ...(current ?? { sessionId: sessionExternalId, providerId }),
              configOptions: updateSessionConfigOptions(current?.configOptions, configId, value),
            },
          }
        })
        setDraftSessionStateByWorkspace((prev) => {
          const current = prev[activeWorkspacePath]
          return {
            ...prev,
            [activeWorkspacePath]: {
              ...(current ?? {}),
              configOptions: updateSessionConfigOptions(current?.configOptions, configId, value),
            },
          }
        })
      } catch (err) {
        setError((err as Error).message)
      }
    },
    [
      activeWorkspacePath,
      currentClientId,
      providerIdForSession,
      rememberWorkspaceConfigValue,
      submitJob,
    ],
  )

  const draftLaunchPreferences = useCallback(
    (workspacePath: string) => {
      const selection = draftSelectionByWorkspaceRef.current[workspacePath] ?? {}
      const providerId = selection.providerId ?? defaultProviderIdRef.current
      const preference =
        workspaceComposerPreferencesRef.current[
          workspaceComposerPreferenceKey(workspacePath, providerId)
        ]
      const resolvedDraft = resolveDraftComposerRuntime({
        workspacePath,
        providerId,
        runtime: draftSessionStateByWorkspaceRef.current[workspacePath],
        selection,
        preference,
        profile: composerProfileForRef(providerId),
      })
      return {
        providerId,
        ...(resolvedDraft.models?.currentModelId
          ? { preferredModelId: resolvedDraft.models.currentModelId }
          : {}),
        ...(resolvedDraft.modes?.currentModeId
          ? { preferredModeId: resolvedDraft.modes.currentModeId }
          : {}),
        ...(preference?.configValues ? { preferredConfigValues: preference.configValues } : {}),
      }
    },
    [composerProfileForRef],
  )

  const sessionLaunchPreferences = useCallback((workspacePath: string, providerId: ProviderId) => {
    const configValues =
      workspaceComposerPreferencesRef.current[
        workspaceComposerPreferenceKey(workspacePath, providerId)
      ]?.configValues
    return configValues ? { preferredConfigValues: configValues } : {}
  }, [])

  useEffect(() => {
    window.electronAPI
      .getProviderComposerProfiles()
      .then((stored) => {
        const next = mergeProviderComposerProfiles(stored, providerComposerProfilesRef.current)
        providerComposerProfilesRef.current = next
        setProviderComposerProfiles(next)
      })
      .catch(() => undefined)
    window.electronAPI
      .getWorkspaceComposerPreferences()
      .then((stored) => {
        const next = mergeWorkspaceComposerPreferences(
          stored,
          workspaceComposerPreferencesRef.current,
        )
        workspaceComposerPreferencesRef.current = next
        setWorkspaceComposerPreferences(next)
      })
      .catch(() => undefined)
  }, [])

  // Convex is the durable, cross-device source for composer profiles and
  // preferences (the electron-store copy above is a machine-local fast path).
  // Both subscriptions are tiny and only push when the projector actually
  // learns something new; merges keep live in-memory state authoritative and
  // bail out before setState when nothing changed, so no extra re-renders.
  const composerProfileDocs = useTrackedQuery(
    'composer.listProfiles',
    (api as any).composer.listProfiles,
    {},
  ) as ProviderComposerProfileDoc[] | undefined
  const composerPreferenceDocs = useTrackedQuery(
    'composer.listPreferences',
    (api as any).composer.listPreferences,
    {},
  ) as WorkspaceComposerPreferenceDoc[] | undefined

  useEffect(() => {
    if (!composerProfileDocs) return
    const stored = composerProfilesFromDocs(composerProfileDocs)
    const next = mergeProviderComposerProfiles(stored, providerComposerProfilesRef.current)
    if (JSON.stringify(next) !== JSON.stringify(providerComposerProfilesRef.current)) {
      providerComposerProfilesRef.current = next
      setProviderComposerProfiles(next)
    }
  }, [composerProfileDocs])

  useEffect(() => {
    if (!composerPreferenceDocs) return
    const stored = composerPreferencesFromDocs(composerPreferenceDocs)
    const next = mergeWorkspaceComposerPreferences(stored, workspaceComposerPreferencesRef.current)
    if (JSON.stringify(next) === JSON.stringify(workspaceComposerPreferencesRef.current)) return
    workspaceComposerPreferencesRef.current = next
    setWorkspaceComposerPreferences(next)
  }, [composerPreferenceDocs])

  useEffect(() => {
    return window.electronAPI.onAcpEvent((event) => {
      if (CHROME_EVENT_TYPES.has(event.event)) {
        setAgentEvents((prev) =>
          prev.some((candidate) => candidate.id === event.id) ? prev : [...prev, event],
        )
      }
      const eventWorkspacePath = event.workspaceId ?? activeWorkspacePath

      switch (event.event) {
        case 'initialized':
          // The handshake identity is remembered in the profile so a provider
          // can be labelled before it has been started again.
          if (event.data.agentInfo) {
            updateProviderComposerProfile(event.providerId, { agentInfo: event.data.agentInfo })
          }
          return
        case 'session_created':
        case 'session_loaded': {
          const models = toAcpModels(event.data.models)
          const modes = toAcpModes(event.data.modes)
          const configOptions = event.data.configOptions
          updateProviderComposerProfile(event.providerId, {
            ...(models?.availableModels?.length ? { availableModels: models.availableModels } : {}),
            ...(modes?.availableModes?.length ? { availableModes: modes.availableModes } : {}),
            ...(event.event === 'session_created' && models?.currentModelId
              ? { defaultModelId: models.currentModelId }
              : {}),
            ...(event.event === 'session_created' && modes?.currentModeId
              ? { defaultModeId: modes.currentModeId }
              : {}),
          })
          setAcpSessionStateById((prev) => ({
            ...prev,
            [event.sessionId]: {
              ...(prev[event.sessionId] ?? {
                sessionId: event.sessionId,
                providerId: event.providerId,
              }),
              providerId: event.providerId,
              ...(models ? { models } : {}),
              ...(modes ? { modes } : {}),
              ...(configOptions ? { configOptions } : {}),
            },
          }))
          if (eventWorkspacePath) {
            mergeDraftRuntimeForWorkspace(eventWorkspacePath, {
              providerId: event.providerId,
              ...(models ? { models } : {}),
              ...(modes ? { modes } : {}),
              ...(configOptions ? { configOptions } : {}),
            })
            if (event.event === 'session_loaded') {
              rememberWorkspaceComposerPreference(
                eventWorkspacePath,
                event.providerId,
                {
                  ...(models?.currentModelId ? { modelId: models.currentModelId } : {}),
                  ...(modes?.currentModeId ? { modeId: modes.currentModeId } : {}),
                },
                false,
              )
            }
          }
          return
        }
        case 'current_model_update': {
          const models = toAcpModels(event.data)
          updateProviderComposerProfile(event.providerId, {
            ...(models?.availableModels?.length ? { availableModels: models.availableModels } : {}),
          })
          setAcpSessionStateById((prev) => ({
            ...prev,
            [event.sessionId]: {
              ...(prev[event.sessionId] ?? {
                sessionId: event.sessionId,
                providerId: event.providerId,
              }),
              providerId: event.providerId,
              models,
            },
          }))
          if (eventWorkspacePath && models) {
            mergeDraftRuntimeForWorkspace(eventWorkspacePath, {
              providerId: event.providerId,
              models,
            })
            if (models.currentModelId) {
              // Fill-only: model updates also fire when the main process
              // restores a reopened session's own model, and that must not
              // overwrite the workspace's last-chosen preference. Explicit
              // user picks persist via setDraftModel/setSessionModel.
              rememberWorkspaceComposerPreference(
                eventWorkspacePath,
                event.providerId,
                { modelId: models.currentModelId },
                false,
              )
            }
          }
          return
        }
        case 'current_mode_update': {
          const modes = toAcpModes(event.data)
          updateProviderComposerProfile(event.providerId, {
            ...(modes?.availableModes?.length ? { availableModes: modes.availableModes } : {}),
          })
          setAcpSessionStateById((prev) => ({
            ...prev,
            [event.sessionId]: {
              ...(prev[event.sessionId] ?? {
                sessionId: event.sessionId,
                providerId: event.providerId,
              }),
              providerId: event.providerId,
              modes,
            },
          }))
          if (eventWorkspacePath && modes) {
            mergeDraftRuntimeForWorkspace(eventWorkspacePath, {
              providerId: event.providerId,
              modes,
            })
            if (modes.currentModeId) {
              // Fill-only, matching the model update handling above.
              rememberWorkspaceComposerPreference(
                eventWorkspacePath,
                event.providerId,
                { modeId: modes.currentModeId },
                false,
              )
            }
          }
          return
        }
        case 'available_commands_update':
          setAcpSessionStateById((prev) => ({
            ...prev,
            [event.sessionId]: {
              ...(prev[event.sessionId] ?? {
                sessionId: event.sessionId,
                providerId: event.providerId,
              }),
              providerId: event.providerId,
              availableCommands: event.data.availableCommands,
            },
          }))
          if (eventWorkspacePath) {
            mergeDraftRuntimeForWorkspace(eventWorkspacePath, {
              providerId: event.providerId,
              availableCommands: event.data.availableCommands,
            })
          }
          return
        case 'config_option_update':
          setAcpSessionStateById((prev) => ({
            ...prev,
            [event.sessionId]: {
              ...(prev[event.sessionId] ?? {
                sessionId: event.sessionId,
                providerId: event.providerId,
              }),
              providerId: event.providerId,
              configOptions: event.data.configOptions,
            },
          }))
          if (eventWorkspacePath) {
            mergeDraftRuntimeForWorkspace(eventWorkspacePath, {
              providerId: event.providerId,
              configOptions: event.data.configOptions,
            })
          }
          return
        case 'session_deleted':
          setAcpSessionStateById((prev) => {
            const next = { ...prev }
            delete next[event.sessionId]
            return next
          })
          return
        default:
          return
      }
    })
  }, [
    activeWorkspacePath,
    mergeDraftRuntimeForWorkspace,
    rememberWorkspaceComposerPreference,
    updateProviderComposerProfile,
  ])

  const acpSessionState = useMemo(() => {
    if (!activeSessionId) return null
    const runtime = acpSessionStateById[activeSessionId]
    if (!runtime) return null
    const preference = activeWorkspacePath
      ? workspaceComposerPreferences[
          workspaceComposerPreferenceKey(activeWorkspacePath, runtime.providerId)
        ]
      : undefined
    return resolveSessionComposerRuntime(
      runtime,
      preference,
      withProviderCatalog(
        providerComposerProfiles[runtime.providerId],
        providers.find((provider) => provider.id === runtime.providerId),
      ),
    )
  }, [
    acpSessionStateById,
    activeSessionId,
    activeWorkspacePath,
    providerComposerProfiles,
    providers,
    workspaceComposerPreferences,
  ])

  /** The remembered config values for whichever provider the composer is
   * pointed at — the live session's provider when there is one, the draft's
   * otherwise. */
  const composerConfigValues = useMemo(() => {
    if (!activeWorkspacePath) return {}
    const providerId = activeSessionId
      ? (acpSessionStateById[activeSessionId]?.providerId ?? defaultProviderId)
      : (draftSessionStateByWorkspace[activeWorkspacePath]?.providerId ??
        draftSelectionByWorkspace[activeWorkspacePath]?.providerId ??
        defaultProviderId)
    return (
      workspaceComposerPreferences[workspaceComposerPreferenceKey(activeWorkspacePath, providerId)]
        ?.configValues ?? {}
    )
  }, [
    acpSessionStateById,
    activeSessionId,
    activeWorkspacePath,
    defaultProviderId,
    draftSelectionByWorkspace,
    draftSessionStateByWorkspace,
    workspaceComposerPreferences,
  ])

  const draftSessionState = useMemo(() => {
    if (!activeWorkspacePath || !isSessionDraftOpen) return null
    const runtime = draftSessionStateByWorkspace[activeWorkspacePath]
    const selection = draftSelectionByWorkspace[activeWorkspacePath]
    const providerId = runtime?.providerId ?? selection?.providerId ?? defaultProviderId
    return resolveDraftComposerRuntime({
      workspacePath: activeWorkspacePath,
      providerId,
      runtime,
      selection,
      preference:
        workspaceComposerPreferences[
          workspaceComposerPreferenceKey(activeWorkspacePath, providerId)
        ],
      profile: withProviderCatalog(
        providerComposerProfiles[providerId],
        providers.find((provider) => provider.id === providerId),
      ),
    })
  }, [
    activeWorkspacePath,
    defaultProviderId,
    draftSelectionByWorkspace,
    draftSessionStateByWorkspace,
    isSessionDraftOpen,
    providerComposerProfiles,
    providers,
    workspaceComposerPreferences,
  ])

  const value = useMemo<ComposerStateValue>(
    () => ({
      acpSessionState,
      draftSessionState,
      composerConfigValues,
      providerComposerProfiles,
      agentEvents,
      error,
      setDraftModel,
      setDraftMode,
      setDraftProvider,
      setDraftConfigOption,
      setSessionModel,
      setSessionMode,
      setSessionConfigOption,
      recordSessionMode,
      draftLaunchPreferences,
      sessionLaunchPreferences,
    }),
    [
      acpSessionState,
      draftSessionState,
      composerConfigValues,
      providerComposerProfiles,
      agentEvents,
      error,
      setDraftModel,
      setDraftMode,
      setDraftProvider,
      setDraftConfigOption,
      setSessionModel,
      setSessionMode,
      setSessionConfigOption,
      recordSessionMode,
      draftLaunchPreferences,
      sessionLaunchPreferences,
    ],
  )

  return <ComposerStateContext.Provider value={value}>{children}</ComposerStateContext.Provider>
}
