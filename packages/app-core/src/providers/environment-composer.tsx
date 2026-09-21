import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { isProviderId, type ProviderId, type SessionConfigOption } from '@agentpack/contract'
import type {
  ProviderComposerProfile,
  ProviderComposerProfiles,
  WorkspaceComposerPreference,
} from '@openmanager/shared/contracts/composer-profile'
import {
  selectComposerPreference,
  selectProviderCatalog,
  shallowEqualArray,
  type EnvironmentState,
  type ProviderCatalogEntry,
} from '@openmanager/environment-client'
import type { SessionConfigValue } from '../components/chat/modelConfig'
import {
  useActiveSession,
  useConnectionState,
  useEnvironmentClient,
  useEnvironmentState,
} from './environment-client'
import {
  ComposerStateContext,
  resolveDraftComposerRuntime,
  resolveSessionComposerRuntime,
  type AcpSessionRuntimeState,
  type ComposerStateValue,
} from './composer-provider'
import {
  PlatformCapabilitiesContext,
  providerBlocksComposer,
  type ProviderUiStatus,
} from './platform-provider'
import { SessionStateContext } from './session-provider'

const EMPTY_RECORD = {}
const EMPTY_LIST: never[] = []
const noop = () => undefined

/** What the user picked in a draft and has not launched yet. It is held here
 * only: the environment learns of it when the draft becomes a session. */
interface DraftSelection {
  providerId: ProviderId
  modelId?: string
  modeId?: string
  configValues?: Record<string, SessionConfigValue>
}

/** What a draft hands to `session.create` when its first prompt is sent. */
export interface DraftLaunch {
  providerId: ProviderId
  /** The draft's held picks. Filed as the workspace preference first, because
   * that is what the environment seeds a new session's selection from. */
  preference?: WorkspaceComposerPreference
  /** A mode other than the provider's default. The environment does not apply
   * a remembered mode on its own, so the session is switched before it is
   * prompted. */
  modeId?: string
}

/** Internal to the environment providers: what the open draft launches with. */
export interface DraftLaunchInternals {
  draftLaunch: (workspaceId: string) => DraftLaunch
  /** The draft became a session: its picks are filed, so holding them any
   * longer would lay them over whatever the workspace remembers next. */
  draftLaunched: (workspaceId: string, launch: DraftLaunch) => void
}

export const DraftLaunchContext = createContext<DraftLaunchInternals | null>(null)

const UNSUPPORTED_PICK = 'This environment cannot change that for a new chat.'
const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

/**
 * The provider a draft in this workspace starts with: the pick when it can
 * still be made, otherwise the first provider the workspace offers that is not
 * known to be broken. An environment that lists no providers keeps the pick.
 */
function draftProviderFor(
  picked: ProviderId,
  catalog: readonly ProviderCatalogEntry[],
  offered: readonly string[] | undefined,
  statuses: Partial<Record<ProviderId, ProviderUiStatus>>,
): ProviderId {
  const candidates = catalog
    .map((entry) => entry.id)
    .filter(isProviderId)
    .filter((id) => !offered?.length || offered.includes(id))
  if (candidates.length === 0 || candidates.includes(picked)) return picked
  return candidates.find((id) => !providerBlocksComposer(statuses[id])) ?? candidates[0]!
}

/**
 * A draft has no session to list its settings, so it borrows the listing of
 * the newest session on the same provider: the one it was opened from, then
 * one in its workspace, then any.
 */
function draftConfigOptions(
  state: EnvironmentState,
  workspaceId: string,
  providerId: ProviderId,
  previousSessionId: string | null,
): SessionConfigOption[] | undefined {
  let best: { rank: number; at: string; options: SessionConfigOption[] } | undefined
  for (const session of Object.values(state.sessions)) {
    const options = session?.composer?.configOptions
    if (!session || !options?.length || session.providerId !== providerId) continue
    const rank =
      session.sessionId === previousSessionId ? 2 : session.workspaceId === workspaceId ? 1 : 0
    const at = session.updatedAt ?? ''
    if (!best || rank > best.rank || (rank === best.rank && at > best.at)) {
      best = { rank, at, options: options as SessionConfigOption[] }
    }
  }
  return best?.options
}

/**
 * The preference as it will stand once the draft's held picks are filed.
 * Without `canSetMode` the mode is left out: a new session would start in the
 * provider's default whatever is remembered, so the draft must not show another.
 */
function withHeldPicks(
  preference: WorkspaceComposerPreference | null,
  held: DraftSelection | undefined,
  canSetMode = true,
): WorkspaceComposerPreference {
  const configValues =
    preference?.configValues || held?.configValues
      ? { ...preference?.configValues, ...held?.configValues }
      : undefined
  return {
    ...((held?.modelId ?? preference?.modelId)
      ? { modelId: held?.modelId ?? preference?.modelId }
      : {}),
    ...(canSetMode && (held?.modeId ?? preference?.modeId)
      ? { modeId: held?.modeId ?? preference?.modeId }
      : {}),
    ...(configValues ? { configValues } : {}),
  }
}

/**
 * Composer state over the environment client. The environment owns all of it:
 * catalogs (`state.providers[id].profile`), each session's selection
 * (`state.sessions[id].composer`) and the workspace's last-used preference.
 * Session setters are plain commands, because the environment pushes the
 * result back to every client, this one included. Only a draft's picks live
 * here, until `session.create` launches with them.
 */
export function EnvironmentComposerStateProvider({ children }: { children: ReactNode }) {
  const client = useEnvironmentClient()
  const { commands } = client
  const {
    activeSessionId,
    activeWorkspacePath,
    isSessionDraftOpen,
    defaultProviderId,
    setDefaultProviderId,
    draftRequest,
  } = useContext(SessionStateContext)!
  const { agentUiStatusByProvider, providerDisplayName } = useContext(PlatformCapabilitiesContext)!
  const catalog = useEnvironmentState(selectProviderCatalog, shallowEqualArray)
  const connection = useConnectionState()
  const connectionPhase = connection.phase
  // Each composer command is negotiated on its own, so a catalog can be
  // listed by an environment that cannot act on a pick. Advertised
  // capabilities arrive with the handshake; this re-reads them on connect.
  const { canFilePicks, canSetMode } = useMemo(
    () => ({
      canFilePicks: client.supports('setComposerPreference'),
      canSetMode: client.supports('setSessionMode'),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client, connection.capabilities],
  )
  const activeSession = useActiveSession()
  const [draftSelections, setDraftSelections] = useState<Record<string, DraftSelection>>({})
  const [error, setError] = useState<string | null>(null)

  const providerComposerProfiles = useMemo(() => {
    const profiles: ProviderComposerProfiles = {}
    for (const entry of catalog) {
      if (isProviderId(entry.id) && entry.profile) profiles[entry.id] = entry.profile
    }
    return profiles
  }, [catalog])

  // The composer reads health for the provider it names, so an open session
  // names its own rather than the draft's.
  const listedProviderId = activeSession?.providerId
  const sessionProviderId = isProviderId(listedProviderId) ? listedProviderId : defaultProviderId

  const draftWorkspaceId = isSessionDraftOpen ? activeWorkspacePath : null
  const offeredProviders = useEnvironmentState((state) =>
    draftWorkspaceId ? state.workspaces[draftWorkspaceId]?.capabilities.providers : undefined,
  )
  const draftProviderId = draftProviderFor(
    (draftWorkspaceId ? draftSelections[draftWorkspaceId]?.providerId : undefined) ??
      defaultProviderId,
    catalog,
    offeredProviders,
    agentUiStatusByProvider,
  )
  // Picks belong to the provider they were made for.
  const held =
    draftWorkspaceId && draftSelections[draftWorkspaceId]?.providerId === draftProviderId
      ? draftSelections[draftWorkspaceId]
      : undefined

  // A failure describes the composer it happened in, not the next one opened.
  useEffect(() => setError(null), [activeSessionId, draftWorkspaceId])

  // The preference for whatever the composer points at: the open session's
  // workspace and provider, or the draft's.
  const preferenceWorkspaceId = activeSession?.workspaceId ?? draftWorkspaceId
  const preferenceProviderId = activeSession ? sessionProviderId : draftProviderId
  const preference = useEnvironmentState((state) =>
    preferenceWorkspaceId
      ? selectComposerPreference(state, preferenceWorkspaceId, preferenceProviderId)
      : null,
  )
  const providerListed = catalog.some((entry) => entry.id === preferenceProviderId)
  useEffect(() => {
    // Not loaded is distinct from empty, and a reconnect without a cursor
    // returns a held preference to not loaded, so this reads it again then.
    if (!preferenceWorkspaceId || preference || !providerListed) return
    if (connectionPhase !== 'connected' || !client.supports('getComposerPreference')) return
    void commands
      .getComposerPreference({
        workspaceId: preferenceWorkspaceId,
        providerId: preferenceProviderId,
      })
      .catch(noop)
  }, [
    client,
    commands,
    connectionPhase,
    preference,
    preferenceProviderId,
    preferenceWorkspaceId,
    providerListed,
  ])

  const sessionComposer = activeSession?.composer
  const acpSessionState = useMemo<AcpSessionRuntimeState | null>(() => {
    if (!activeSessionId) return null
    const runtime: AcpSessionRuntimeState = {
      sessionId: activeSessionId,
      providerId: sessionProviderId,
      ...(sessionComposer?.configOptions
        ? { configOptions: sessionComposer.configOptions as SessionConfigOption[] }
        : {}),
      ...(sessionComposer?.modelId ? { models: { currentModelId: sessionComposer.modelId } } : {}),
      ...(sessionComposer?.modeId ? { modes: { currentModeId: sessionComposer.modeId } } : {}),
    }
    return resolveSessionComposerRuntime(
      runtime,
      // The session's own values are what the environment re-applies; the
      // workspace's only stand in for a session that has none yet.
      { ...preference, configValues: sessionComposer?.configValues ?? preference?.configValues },
      providerComposerProfiles[sessionProviderId],
      { modelOwner: 'session' },
    )
  }, [activeSessionId, preference, providerComposerProfiles, sessionComposer, sessionProviderId])

  const previousSessionId =
    draftRequest && draftRequest.workspacePath === draftWorkspaceId
      ? draftRequest.previousSessionId
      : null
  const borrowedConfigOptions = useEnvironmentState((state) =>
    draftWorkspaceId
      ? draftConfigOptions(state, draftWorkspaceId, draftProviderId, previousSessionId)
      : undefined,
  )
  const draftPreference = useMemo(
    () => withHeldPicks(preference, held, canSetMode),
    [canSetMode, held, preference],
  )
  const draftSessionState = useMemo<AcpSessionRuntimeState | null>(
    () =>
      draftWorkspaceId
        ? resolveDraftComposerRuntime({
            workspacePath: draftWorkspaceId,
            providerId: draftProviderId,
            ...(borrowedConfigOptions ? { runtime: { configOptions: borrowedConfigOptions } } : {}),
            preference: draftPreference,
            profile: providerComposerProfiles[draftProviderId],
          })
        : null,
    [
      borrowedConfigOptions,
      draftPreference,
      draftProviderId,
      draftWorkspaceId,
      providerComposerProfiles,
    ],
  )

  const composerConfigValues = activeSessionId
    ? (sessionComposer?.configValues ?? preference?.configValues ?? EMPTY_RECORD)
    : (draftPreference.configValues ?? EMPTY_RECORD)

  // Setters and launch readers run outside render; they read the latest here
  // rather than being rebuilt (and re-rendering the composer) on every change.
  const live = { catalog, agentUiStatusByProvider, defaultProviderId, draftSelections }
  const liveRef = useRef(live)
  liveRef.current = live

  const draftFor = useCallback(
    (workspaceId: string) => {
      const state = client.getState()
      const { catalog, agentUiStatusByProvider, defaultProviderId, draftSelections } =
        liveRef.current
      const selection = draftSelections[workspaceId]
      const providerId = draftProviderFor(
        selection?.providerId ?? defaultProviderId,
        catalog,
        state.workspaces[workspaceId]?.capabilities.providers,
        agentUiStatusByProvider,
      )
      const held = selection?.providerId === providerId ? selection : undefined
      const profile: ProviderComposerProfile | undefined = state.providers[providerId]?.profile
      const preference = withHeldPicks(
        selectComposerPreference(state, workspaceId, providerId),
        held,
        client.supports('setSessionMode'),
      )
      const resolved = resolveDraftComposerRuntime({
        workspacePath: workspaceId,
        providerId,
        preference,
        profile,
      })
      return { providerId, held, profile, preference, resolved }
    },
    [client],
  )

  const holdDraftPick = useCallback(
    (supported: boolean, pick: (current: DraftSelection) => DraftSelection) => {
      if (!draftWorkspaceId) return
      if (!supported) {
        // Holding a pick the launch cannot honour would show one thing and run another.
        setError(UNSUPPORTED_PICK)
        return
      }
      setError(null)
      setDraftSelections((prev) => {
        const current = prev[draftWorkspaceId]
        return {
          ...prev,
          [draftWorkspaceId]: pick(
            current?.providerId === draftProviderId ? current : { providerId: draftProviderId },
          ),
        }
      })
    },
    [draftProviderId, draftWorkspaceId],
  )

  const setDraftProvider = useCallback(
    (providerId: ProviderId, modelId?: string) => {
      if (!draftWorkspaceId) return
      if (providerBlocksComposer(liveRef.current.agentUiStatusByProvider[providerId])) {
        setError(`${providerDisplayName(providerId)} is unavailable. Retry it from Settings.`)
        return
      }
      // The provider itself rides `session.create`; only the model needs filing.
      setError(modelId && !canFilePicks ? UNSUPPORTED_PICK : null)
      // New drafts elsewhere follow the last provider picked, as on desktop.
      setDefaultProviderId(providerId)
      setDraftSelections((prev) => ({
        ...prev,
        [draftWorkspaceId]: { providerId, ...(modelId && canFilePicks ? { modelId } : {}) },
      }))
    },
    [canFilePicks, draftWorkspaceId, providerDisplayName, setDefaultProviderId],
  )

  // The picks each launch was built from. Every pick replaces the workspace's
  // selection object, so identity tells a launched draft's picks from those of
  // a newer draft opened in the same workspace while the launch was running.
  const launchedPicks = useRef(new WeakMap<DraftLaunch, DraftSelection>())
  const draftLaunched = useCallback((workspaceId: string, launch: DraftLaunch) => {
    const launched = launchedPicks.current.get(launch)
    setDraftSelections((prev) => {
      const current = prev[workspaceId]
      if (!current || current !== launched) return prev
      // The provider is not part of the preference, so the workspace keeps it.
      return { ...prev, [workspaceId]: { providerId: current.providerId } }
    })
  }, [])

  const runSessionSetter = useCallback(async (work: () => Promise<unknown>) => {
    setError(null)
    try {
      // Nothing to record on success: the environment answers, then pushes
      // `session.composer.updated` to every client, including this one.
      await work()
    } catch (err) {
      setError(message(err))
    }
  }, [])

  const draftLaunch = useCallback(
    (workspaceId: string): DraftLaunch => {
      const { providerId, held, profile, resolved } = draftFor(workspaceId)
      // Only what was picked here: filing resolved defaults as "last used"
      // would pin the workspace to them.
      const picks = withHeldPicks(null, held)
      const modeId = resolved.modes?.currentModeId
      const launch: DraftLaunch = {
        providerId,
        ...(Object.keys(picks).length > 0 ? { preference: picks } : {}),
        ...(modeId && modeId !== profile?.defaultModeId ? { modeId } : {}),
      }
      if (held) launchedPicks.current.set(launch, held)
      return launch
    },
    [draftFor],
  )

  const launchInternals = useMemo<DraftLaunchInternals>(
    () => ({ draftLaunch, draftLaunched }),
    [draftLaunch, draftLaunched],
  )

  const value = useMemo<ComposerStateValue>(
    () => ({
      acpSessionState,
      draftSessionState,
      composerConfigValues,
      providerComposerProfiles,
      agentEvents: EMPTY_LIST,
      error,
      setDraftModel: (modelId) =>
        holdDraftPick(canFilePicks, (current) => ({ ...current, modelId })),
      setDraftMode: (modeId) => holdDraftPick(canSetMode, (current) => ({ ...current, modeId })),
      setDraftProvider,
      setDraftConfigOption: (configId, value) =>
        holdDraftPick(canFilePicks, (current) => ({
          ...current,
          configValues: { ...current.configValues, [configId]: value },
        })),
      setSessionModel: (sessionId, modelId) =>
        runSessionSetter(() => commands.setSessionModel({ sessionId, modelId })),
      setSessionMode: (sessionId, modeId) =>
        runSessionSetter(() => commands.setSessionMode({ sessionId, modeId })),
      setSessionConfigOption: (sessionId, configId, value) =>
        runSessionSetter(() => commands.setSessionConfigOption({ sessionId, configId, value })),
      // The environment records a plan build's mode itself and pushes it.
      recordSessionMode: noop,
      draftLaunchPreferences: (workspaceId) => {
        const { providerId, preference, resolved } = draftFor(workspaceId)
        return {
          providerId,
          ...(resolved.models?.currentModelId
            ? { preferredModelId: resolved.models.currentModelId }
            : {}),
          ...(resolved.modes?.currentModeId
            ? { preferredModeId: resolved.modes.currentModeId }
            : {}),
          ...(preference.configValues ? { preferredConfigValues: preference.configValues } : {}),
        }
      },
      sessionLaunchPreferences: (workspaceId, providerId) => {
        const configValues = selectComposerPreference(
          client.getState(),
          workspaceId,
          providerId,
        )?.configValues
        return configValues ? { preferredConfigValues: configValues } : {}
      },
    }),
    [
      acpSessionState,
      canFilePicks,
      canSetMode,
      client,
      commands,
      composerConfigValues,
      draftFor,
      draftSessionState,
      error,
      holdDraftPick,
      providerComposerProfiles,
      runSessionSetter,
      setDraftProvider,
    ],
  )

  return (
    <ComposerStateContext.Provider value={value}>
      <DraftLaunchContext.Provider value={launchInternals}>{children}</DraftLaunchContext.Provider>
    </ComposerStateContext.Provider>
  )
}
