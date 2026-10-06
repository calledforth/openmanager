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
import type { DraftContent } from '@openmanager/protocol'
import {
  selectComposerPreference,
  selectDraftContent,
  selectDraftTarget,
  selectProviderCatalog,
  shallowEqualArray,
  type EnvironmentState,
  type ProviderCatalogEntry,
  type SessionComposerState,
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
  type AcpCommandOption,
  type AcpSessionRuntimeState,
  type ComposerStateValue,
} from './composer-provider'
import { DraftPageContext, DraftPicksContext, type DraftPagePicks } from './draft-pages'
import { latestSendingDraft } from './environment-drafts'
import {
  PlatformCapabilitiesContext,
  providerBlocksComposer,
  type ProviderUiStatus,
} from './platform-provider'
import { SessionStateContext } from './session-provider'

const EMPTY_RECORD = {}
const EMPTY_LIST: never[] = []
const noop = () => undefined

/**
 * What the user explicitly picked in a draft. Only these are kept with the
 * draft: in its record where the environment keeps drafts and it has been
 * saved, else on the page until its first save. What the composer seeds
 * from the project's last-used preference is never stored; it is worked out
 * again each time the draft is shown, so it follows the project.
 */
interface DraftSelection {
  providerId: ProviderId
  modelId?: string
  modeId?: string
  configValues?: Record<string, SessionConfigValue>
}

/** The picks a draft holds; a pick belongs to the provider it was made for. */
function selectionOf(content: DraftContent | undefined): DraftSelection | undefined {
  if (!content?.providerId || !isProviderId(content.providerId)) return undefined
  return { ...content.preference, providerId: content.providerId }
}

/** The picks as a draft records them. */
function picksContent(selection: DraftSelection): Pick<DraftContent, 'providerId' | 'preference'> {
  const { providerId, ...picks } = selection
  const preference = Object.fromEntries(
    Object.entries(picks).filter(([, value]) => value !== undefined),
  ) as WorkspaceComposerPreference
  return { providerId, ...(Object.keys(preference).length > 0 ? { preference } : {}) }
}

/** The draft with `selection` as its picks, keeping what was typed and attached. */
function withSelection(content: DraftContent | undefined, selection: DraftSelection): DraftContent {
  return {
    text: content?.text ?? '',
    ...(content?.artifactIds ? { artifactIds: content.artifactIds } : {}),
    ...picksContent(selection),
  }
}

/** What a draft hands to `session.create` when its first prompt is sent. */
export interface DraftLaunch {
  providerId: ProviderId
  /** The draft's explicit picks. The environment files them as the workspace
   * preference before it starts the provider: a launch is where a draft's
   * picks become "last used", never the picking itself. */
  preference?: WorkspaceComposerPreference
  /** A mode other than the provider's default. The environment does not apply
   * a remembered mode on its own, so the create names it and the first
   * message runs in it. */
  modeId?: string
  /** The project the draft is sent from; null when its own was removed and
   * none picked since. Absent: the page's. */
  workspaceId?: string | null
  /** The draft being sent, where the environment keeps drafts: it is deleted
   * with the session's creation, and the session takes the id it minted. */
  draft?: { draftId: string; sessionId: string }
}

/** Internal to the environment providers: what the open draft launches with. */
export interface DraftLaunchInternals {
  draftLaunch: (workspaceId: string) => DraftLaunch
  /** The draft became a session: the picks held for it are done with. */
  draftLaunched: (launch: DraftLaunch) => void
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
 * The provider this workspace last ran: that of its most recently active
 * top-level session. The environment keeps preferences per provider and none
 * for the provider itself, so the sessions are the record, for every client.
 */
function lastProviderIn(state: EnvironmentState, workspaceId: string): ProviderId | undefined {
  let best: { at: string; providerId: ProviderId } | undefined
  for (const session of Object.values(state.sessions)) {
    if (!session || session.workspaceId !== workspaceId || session.parentSessionId) continue
    if (!isProviderId(session.providerId)) continue
    const at = session.updatedAt ?? ''
    if (!best || at > best.at) best = { at, providerId: session.providerId }
  }
  return best?.providerId
}

/**
 * A draft has no session to list its settings or commands, so it borrows the
 * listing of the newest session on the same provider: the one it was opened
 * from, then one in its workspace, then any. An empty command listing is the
 * provider saying it offers none, so it is an answer; an empty settings
 * listing is only a session that has not reported yet.
 */
function draftListing<K extends 'configOptions' | 'availableCommands'>(
  state: EnvironmentState,
  listing: K,
  workspaceId: string,
  providerId: ProviderId,
  previousSessionId: string | null,
): NonNullable<SessionComposerState[K]> | undefined {
  let best: { rank: number; at: string; listed: NonNullable<SessionComposerState[K]> } | undefined
  for (const session of Object.values(state.sessions)) {
    const listed = session?.composer?.[listing]
    const reported = listing === 'availableCommands' ? listed !== undefined : !!listed?.length
    if (!session || !listed || !reported || session.providerId !== providerId) continue
    const rank =
      session.sessionId === previousSessionId ? 2 : session.workspaceId === workspaceId ? 1 : 0
    const at = session.updatedAt ?? ''
    if (!best || rank > best.rank || (rank === best.rank && at > best.at)) {
      best = { rank, at, listed }
    }
  }
  return best?.listed
}

/** The wire keeps only a command's hint; the composer reads it as ACP input. */
const toAcpCommands = (
  commands: NonNullable<SessionComposerState['availableCommands']>,
): AcpCommandOption[] =>
  commands.map((command) => ({
    name: command.name,
    description: command.description,
    ...(command.placeholder
      ? { input: { type: 'unstructured' as const, placeholder: command.placeholder } }
      : {}),
  }))

/**
 * What a draft shows and launches with: the project's last-used preference,
 * with the draft's explicit picks over it. Read whenever the draft is shown,
 * so a seeded value follows whatever the project last used, including a
 * change made in one of its sessions a moment ago. Without `canSetMode` the
 * mode is left out: a new session would start in the provider's default
 * whatever is remembered, so the draft must not show another.
 */
function withExplicitPicks(
  preference: WorkspaceComposerPreference | null,
  picked: DraftSelection | undefined,
  canSetMode = true,
): WorkspaceComposerPreference {
  const configValues =
    preference?.configValues || picked?.configValues
      ? { ...preference?.configValues, ...picked?.configValues }
      : undefined
  return {
    ...((picked?.modelId ?? preference?.modelId)
      ? { modelId: picked?.modelId ?? preference?.modelId }
      : {}),
    ...(canSetMode && (picked?.modeId ?? preference?.modeId)
      ? { modeId: picked?.modeId ?? preference?.modeId }
      : {}),
    ...(configValues ? { configValues } : {}),
  }
}

/**
 * Composer state over the environment client. The environment owns all of it:
 * catalogs (`state.providers[id].profile`), each session's selection
 * (`state.sessions[id].composer`) and the workspace's last-used preference.
 * Session setters are plain commands, because the environment pushes the
 * result back to every client, this one included. A draft's explicit picks
 * are kept with the draft; picking never writes the workspace's preference.
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
  const draftPage = useContext(DraftPageContext)
  const { agentUiStatusByProvider, providerDisplayName } = useContext(PlatformCapabilitiesContext)!
  const catalog = useEnvironmentState(selectProviderCatalog, shallowEqualArray)
  const connection = useConnectionState()
  const connectionPhase = connection.phase
  // Each composer command is negotiated on its own, so a catalog can be
  // listed by an environment that cannot act on a pick. Advertised
  // capabilities arrive with the handshake; this re-reads them on connect.
  // A model or setting pick reaches the environment with the launch, which
  // files it as the preference the new session is seeded from: an
  // environment that keeps no preference cannot honour one.
  const { canKeepPicks, canSetMode } = useMemo(
    () => ({
      canKeepPicks: client.supports('setComposerPreference'),
      canSetMode: client.supports('setSessionMode'),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client, connection.capabilities],
  )
  const activeSession = useActiveSession()
  const sync = client.drafts
  // Picks made on a draft the environment does not have yet, by draft id.
  // Its first save takes them along.
  const [pagePicks, setPagePicks] = useState<Record<string, DraftSelection>>({})
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
  const draftId = isSessionDraftOpen ? (draftPage?.pageDraftId ?? null) : null
  // Three selectors, so typing (which replaces the draft's content but not
  // its picks) does not hand the composer a new selection on every key.
  const savedDraft = useEnvironmentState((state) =>
    sync && draftId ? selectDraftContent(state, draftId) !== undefined : false,
  )
  const savedProviderId = useEnvironmentState((state) =>
    sync && draftId ? selectDraftContent(state, draftId)?.providerId : undefined,
  )
  const savedPreference = useEnvironmentState((state) =>
    sync && draftId ? selectDraftContent(state, draftId)?.preference : undefined,
  )
  const currentSelection = useMemo(
    () =>
      savedDraft
        ? selectionOf(
            savedProviderId
              ? { text: '', providerId: savedProviderId, preference: savedPreference }
              : undefined,
          )
        : draftId
          ? pagePicks[draftId]
          : undefined,
    [draftId, pagePicks, savedDraft, savedPreference, savedProviderId],
  )
  const offeredProviders = useEnvironmentState((state) =>
    draftWorkspaceId ? state.workspaces[draftWorkspaceId]?.capabilities.providers : undefined,
  )
  const lastProviderId = useEnvironmentState((state) =>
    draftWorkspaceId ? lastProviderIn(state, draftWorkspaceId) : undefined,
  )
  const draftProviderId = draftProviderFor(
    currentSelection?.providerId ?? lastProviderId ?? defaultProviderId,
    catalog,
    offeredProviders,
    agentUiStatusByProvider,
  )
  // Picks belong to the provider they were made for.
  const picked = currentSelection?.providerId === draftProviderId ? currentSelection : undefined

  // A failure describes the composer it happened in, not the next one opened.
  useEffect(() => setError(null), [activeSessionId, draftId, draftWorkspaceId])

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
      ...(sessionComposer?.availableCommands
        ? { availableCommands: toAcpCommands(sessionComposer.availableCommands) }
        : {}),
      ...(sessionComposer?.usage ? { usage: sessionComposer.usage } : {}),
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
      ? (draftListing(
          state,
          'configOptions',
          draftWorkspaceId,
          draftProviderId,
          previousSessionId,
        ) as SessionConfigOption[] | undefined)
      : undefined,
  )
  const borrowedCommands = useEnvironmentState((state) =>
    draftWorkspaceId
      ? draftListing(
          state,
          'availableCommands',
          draftWorkspaceId,
          draftProviderId,
          previousSessionId,
        )
      : undefined,
  )
  const draftPreference = useMemo(
    () => withExplicitPicks(preference, picked, canSetMode),
    [canSetMode, picked, preference],
  )
  const draftSessionState = useMemo<AcpSessionRuntimeState | null>(
    () =>
      draftWorkspaceId
        ? resolveDraftComposerRuntime({
            workspacePath: draftWorkspaceId,
            providerId: draftProviderId,
            ...(borrowedConfigOptions || borrowedCommands
              ? {
                  runtime: {
                    ...(borrowedConfigOptions ? { configOptions: borrowedConfigOptions } : {}),
                    ...(borrowedCommands
                      ? { availableCommands: toAcpCommands(borrowedCommands) }
                      : {}),
                  },
                }
              : {}),
            preference: draftPreference,
            profile: providerComposerProfiles[draftProviderId],
          })
        : null,
    [
      borrowedCommands,
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
  const live = { catalog, agentUiStatusByProvider, defaultProviderId, pagePicks, draftId }
  const liveRef = useRef(live)
  liveRef.current = live
  const draftPageRef = useRef(draftPage)
  draftPageRef.current = draftPage

  /** A draft's explicit picks: in its saved record, else held on the page. */
  const explicitPicks = useCallback(
    (state: EnvironmentState, id: string | null) => {
      if (!id) return undefined
      const content = sync ? selectDraftContent(state, id) : undefined
      return content ? selectionOf(content) : liveRef.current.pagePicks[id]
    },
    [sync],
  )

  /** A draft as it would launch from `workspaceId`. */
  const draftFor = useCallback(
    (workspaceId: string, id: string | null) => {
      const state = client.getState()
      const { catalog, agentUiStatusByProvider, defaultProviderId } = liveRef.current
      const selection = explicitPicks(state, id)
      const providerId = draftProviderFor(
        selection?.providerId ?? lastProviderIn(state, workspaceId) ?? defaultProviderId,
        catalog,
        state.workspaces[workspaceId]?.capabilities.providers,
        agentUiStatusByProvider,
      )
      const picked = selection?.providerId === providerId ? selection : undefined
      const profile: ProviderComposerProfile | undefined = state.providers[providerId]?.profile
      const preference = withExplicitPicks(
        selectComposerPreference(state, workspaceId, providerId),
        picked,
        client.supports('setSessionMode'),
      )
      const resolved = resolveDraftComposerRuntime({
        workspacePath: workspaceId,
        providerId,
        preference,
        profile,
      })
      return { providerId, picked, profile, preference, resolved }
    },
    [client, explicitPicks],
  )

  /** Change the open draft's picks: in its record once saved, else on the page. */
  const updateSelection = useCallback(
    (update: (current: DraftSelection | undefined) => DraftSelection) => {
      const id = liveRef.current.draftId
      if (!id) return
      const state = client.getState()
      const content = sync ? selectDraftContent(state, id) : undefined
      const target = content ? selectDraftTarget(state, id) : undefined
      if (sync && content && target) {
        sync.edit(id, target, withSelection(content, update(selectionOf(content))))
        return
      }
      // Picks alone are not worth a draft: nothing is saved, and the page
      // keeps no address for them, until something is typed or attached.
      setPagePicks((prev) => ({ ...prev, [id]: update(prev[id]) }))
    },
    [client, sync],
  )

  const pickDraft = useCallback(
    (supported: boolean, pick: (current: DraftSelection) => DraftSelection) => {
      if (!draftWorkspaceId) return
      if (!supported) {
        // Keeping a pick the launch cannot honour would show one thing and run another.
        setError(UNSUPPORTED_PICK)
        return
      }
      setError(null)
      updateSelection((current) =>
        pick(current?.providerId === draftProviderId ? current : { providerId: draftProviderId }),
      )
    },
    [draftProviderId, draftWorkspaceId, updateSelection],
  )

  const setDraftProvider = useCallback(
    (providerId: ProviderId, modelId?: string) => {
      if (!draftWorkspaceId) return
      if (providerBlocksComposer(liveRef.current.agentUiStatusByProvider[providerId])) {
        setError(`${providerDisplayName(providerId)} is unavailable. Retry it from Settings.`)
        return
      }
      // The provider itself rides `session.create`; a model needs a preference.
      setError(modelId && !canKeepPicks ? UNSUPPORTED_PICK : null)
      // New drafts elsewhere follow the last provider picked, as on desktop.
      setDefaultProviderId(providerId)
      updateSelection(() => ({
        providerId,
        ...(modelId && canKeepPicks ? { modelId } : {}),
      }))
    },
    [canKeepPicks, draftWorkspaceId, providerDisplayName, setDefaultProviderId, updateSelection],
  )

  // The page each launch was built from, so its held picks go with it.
  const launchedPages = useRef(new WeakMap<DraftLaunch, string>())
  const draftLaunched = useCallback((launch: DraftLaunch) => {
    const id = launchedPages.current.get(launch)
    if (!id) return
    setPagePicks((prev) => {
      if (!(id in prev)) return prev
      const next = { ...prev }
      delete next[id]
      return next
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
      // The draft the composer set aside when send was pressed. It launches
      // from its own project even if the page moved on while images uploaded.
      const sending = sync ? latestSendingDraft(sync) : undefined
      const id = sending?.draftId ?? liveRef.current.draftId
      let kept = sending ? { draftId: sending.draftId, sessionId: sending.sessionId } : undefined
      if (sync && !sending && id) {
        // Not sent from the composer: the open draft, with the session id
        // minted for it, whether or not the environment has it yet.
        const target =
          selectDraftTarget(client.getState(), id) ?? draftPageRef.current?.pageTarget(id)
        if (target?.type === 'new_session') kept = { draftId: id, sessionId: target.sessionId }
      }
      const launchWorkspaceId = sending ? sending.workspaceId : workspaceId
      const { providerId, picked, profile, preference, resolved } = draftFor(
        launchWorkspaceId ?? workspaceId,
        id,
      )
      // Only what was picked here: filing seeded values as "last used" would
      // pin the workspace to them. Settings are one value to the environment,
      // which replaces them whole, so a settings pick carries every setting
      // the draft shows; otherwise the seeded ones would be dropped.
      const settings = picked?.configValues ? preference.configValues : undefined
      const picks = {
        ...withExplicitPicks(null, picked),
        ...(settings ? { configValues: settings } : {}),
      }
      const modeId = resolved.modes?.currentModeId
      const launch: DraftLaunch = {
        providerId,
        ...(Object.keys(picks).length > 0 ? { preference: picks } : {}),
        ...(modeId && modeId !== profile?.defaultModeId ? { modeId } : {}),
        ...(sending ? { workspaceId: launchWorkspaceId } : {}),
        ...(kept ? { draft: kept } : {}),
      }
      if (id) launchedPages.current.set(launch, id)
      return launch
    },
    [client, draftFor, sync],
  )

  const launchInternals = useMemo<DraftLaunchInternals>(
    () => ({ draftLaunch, draftLaunched }),
    [draftLaunch, draftLaunched],
  )

  // A draft's first save takes the picks the page held for it.
  const picksForSave = useCallback<DraftPagePicks>((id) => {
    const selection = liveRef.current.pagePicks[id]
    return selection ? picksContent(selection) : undefined
  }, [])

  const value = useMemo<ComposerStateValue>(
    () => ({
      acpSessionState,
      draftSessionState,
      composerConfigValues,
      providerComposerProfiles,
      agentEvents: EMPTY_LIST,
      error,
      setDraftModel: (modelId) => pickDraft(canKeepPicks, (current) => ({ ...current, modelId })),
      setDraftMode: (modeId) => pickDraft(canSetMode, (current) => ({ ...current, modeId })),
      setDraftProvider,
      setDraftConfigOption: (configId, value) =>
        pickDraft(canKeepPicks, (current) => ({
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
        const { providerId, preference, resolved } = draftFor(workspaceId, liveRef.current.draftId)
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
      canKeepPicks,
      canSetMode,
      client,
      commands,
      composerConfigValues,
      draftFor,
      draftSessionState,
      error,
      pickDraft,
      providerComposerProfiles,
      runSessionSetter,
      setDraftProvider,
    ],
  )

  return (
    <ComposerStateContext.Provider value={value}>
      <DraftLaunchContext.Provider value={launchInternals}>
        <DraftPicksContext.Provider value={picksForSave}>{children}</DraftPicksContext.Provider>
      </DraftLaunchContext.Provider>
    </ComposerStateContext.Provider>
  )
}
