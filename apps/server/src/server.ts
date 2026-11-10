import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  PLAN_BUILD_CAPABILITY,
  BootstrapResponseSchema,
  COMPOSER_CONFIG_OPTION_SET_CAPABILITY,
  COMPOSER_EVENTS_CAPABILITY,
  COMPOSER_MODEL_SET_CAPABILITY,
  COMPOSER_MODE_SET_CAPABILITY,
  COMPOSER_PREFERENCES_SET_CAPABILITY,
  ENVIRONMENT_SETTINGS_GET_CAPABILITY,
  ENVIRONMENT_SETTINGS_SET_CAPABILITY,
  DRAFT_DELETE_CAPABILITY,
  DRAFT_LIST_CAPABILITY,
  DRAFT_SAVE_CAPABILITY,
  CLIENT_LIST_CAPABILITY,
  CLIENT_OWNER_ROTATE_CAPABILITY,
  CLIENT_RENAME_CAPABILITY,
  CLIENT_REVOKE_CAPABILITY,
  CLIENT_REVOKE_OTHERS_CAPABILITY,
  ENVIRONMENT_RENAME_CAPABILITY,
  FILESYSTEM_BROWSE_CAPABILITY,
  PROTOCOL_VERSION,
  SEARCH_MESSAGES_CAPABILITY,
  SESSION_CREATE_EXPLICIT_CAPABILITY,
  UPLOAD_TICKET_CAPABILITY,
  PROVIDER_CATALOG_CAPABILITY,
  PROVIDER_DISCOVERY_CAPABILITY,
  PROVIDER_HEALTH_CAPABILITY,
  PROVIDER_PROBE_CAPABILITY,
  PROVIDER_LIMITS_REFRESH_CAPABILITY,
  PAIRING_CREATE_CAPABILITY,
  PAIRING_EXCHANGE_CAPABILITY,
  PAIRING_LIST_CAPABILITY,
  PAIRING_REDEEM_CAPABILITY,
  PAIRING_REVOKE_CAPABILITY,
  PULL_REQUEST_GET_CAPABILITY,
  type DurableEvent,
  type ProofEvent,
  type WorkspaceComposerPreference,
} from '@openmanager/protocol/node'
import {
  providers,
  type HostDeps,
  type ProviderBootstrap as RuntimeProviderBootstrap,
} from '@agentpack/runtime/node'
import { mountAgentRuntime } from './agent-runtime.ts'
import { createComposerService, desiredSessionConfig } from './composer-service.ts'
import { createDraftService } from './draft-service.ts'
import { openComposerStore } from './composer-store.ts'
import { openEnvironmentSettings } from './environment-settings.ts'
import { createTitleGenerator } from './session-titles/generator.ts'
import { createFilesystemService } from './filesystem.ts'
import { createMessageSearch } from './message-search.ts'
import { createGitHubReader, createGitHubToken } from './pull-requests/github.ts'
import { createAgentToolsEndpoint } from './pull-requests/mcp-endpoint.ts'
import { createPullRequestService } from './pull-requests/service.ts'
import { serverVersion } from './standalone/version.ts'
import { auditValue, createAuditLog } from './audit.ts'
import type { ServerConfig } from './config.ts'
import { validateHosts, validateOrigins, validateWorkspaceRoots } from './config.ts'
import { openAuthorizedClients } from './authorized-clients.ts'
import {
  createPairingService,
  GRANT_CHANGED_CLOSE_CODE,
  GRANT_CHANGED_CLOSE_REASON,
} from './pairing.ts'
import { createClientService, type ClientSockets } from './client-service.ts'
import { createEnvironmentNameService } from './environment-name.ts'
import { loadEnvironmentIdentity } from './identity.ts'
import { detectEnvironmentPlatform } from './platform.ts'
import {
  evaluateLocalOwnerAccess,
  evaluateLocalOwnerRouteAccess,
  LOCAL_OWNER_CLAIM_HEADER,
  LOCAL_OWNER_PATH,
} from './local-owner.ts'
import { createDeliveryQueue } from './event-delivery.ts'
import { createPersistentEventService } from './event-service.ts'
import { openEnvironmentDatabase } from './db/database.ts'
import { raiseReplayFloors } from './db/replay-floor.ts'
import { reconcileAfterRestart } from './db/boot-reconcile.ts'
import { createEventRetention } from './db/event-retention.ts'
import { createReplayReader } from './db/replay.ts'
import { readWorkspaceListing } from './db/composer-rows.ts'
import { getSessionSummary, readThreadListing } from './db/session-store.ts'
import { createLogger, resolveLogSink } from './logger.ts'
import { createProviderLimits, openProviderLimitsStore } from './provider-limits.ts'
import { createProviderService } from './provider-service.ts'
import { createRateLimiter } from './rate-limit.ts'
import { createRequestGuard } from './request-guard.ts'
import { createThreadService, type WorkspaceRuntimeResolver } from './thread-service.ts'
import {
  clearTunnelStatus,
  createTunnelSupervisor,
  CLOUDFLARED_CONFIG_FILE_NAME,
  TUNNEL_CHECK_PATH,
  TUNNEL_STATUS_FILE_NAME,
  type TunnelSupervisor,
} from './tunnel.ts'
import { createBudgetKey } from './budget-key.ts'
import { createArtifactStore } from './artifacts.ts'
import { createToolOutputReader } from './db/tool-output.ts'
import { createUploadService } from './uploads.ts'
import { attachWebSocket, SOCKET_CAPABILITIES } from './websocket.ts'
import { openWorkspaceRegistry } from './workspaces.ts'

export const SERVER_CAPABILITIES = [
  ...SOCKET_CAPABILITIES,
  PROVIDER_DISCOVERY_CAPABILITY,
  PROVIDER_HEALTH_CAPABILITY,
  PROVIDER_PROBE_CAPABILITY,
  PROVIDER_LIMITS_REFRESH_CAPABILITY,
  PROVIDER_CATALOG_CAPABILITY,
  COMPOSER_PREFERENCES_SET_CAPABILITY,
  COMPOSER_MODEL_SET_CAPABILITY,
  COMPOSER_MODE_SET_CAPABILITY,
  COMPOSER_CONFIG_OPTION_SET_CAPABILITY,
  COMPOSER_EVENTS_CAPABILITY,
  'session.create',
  SESSION_CREATE_EXPLICIT_CAPABILITY,
  'session.open',
  'session.rename',
  'session.delete',
  'session.title.regenerate',
  'session.settle',
  'session.pin',
  'session.acknowledge',
  'session.background.stop',
  'turn.send',
  'turn.interrupt',
  'queue.add',
  'queue.remove',
  'queue.resume',
  'turn.steer',
  'interaction.respond',
  PLAN_BUILD_CAPABILITY,
  'workspace.list',
  'workspace.add',
  'workspace.remove',
  'workspace.icon',
  UPLOAD_TICKET_CAPABILITY,
  FILESYSTEM_BROWSE_CAPABILITY,
  ENVIRONMENT_SETTINGS_GET_CAPABILITY,
  ENVIRONMENT_SETTINGS_SET_CAPABILITY,
  SEARCH_MESSAGES_CAPABILITY,
  PULL_REQUEST_GET_CAPABILITY,
  DRAFT_LIST_CAPABILITY,
  DRAFT_SAVE_CAPABILITY,
  DRAFT_DELETE_CAPABILITY,
  PAIRING_CREATE_CAPABILITY,
  PAIRING_LIST_CAPABILITY,
  PAIRING_REVOKE_CAPABILITY,
  PAIRING_REDEEM_CAPABILITY,
  PAIRING_EXCHANGE_CAPABILITY,
  CLIENT_LIST_CAPABILITY,
  CLIENT_RENAME_CAPABILITY,
  CLIENT_REVOKE_CAPABILITY,
  CLIENT_REVOKE_OTHERS_CAPABILITY,
  CLIENT_OWNER_ROTATE_CAPABILITY,
  ENVIRONMENT_RENAME_CAPABILITY,
]

/** A loopback-only listener exposing public liveness and connection discovery. */
export async function startServer(config: ServerConfig) {
  const allowedOrigins = validateOrigins(config.allowedOrigins ?? [])
  // The tunnel's hostname is how Cloudflare's requests arrive (`Host` is not
  // rewritten), so running a tunnel allows it.
  const allowedHosts = validateHosts([
    ...(config.allowedHosts ?? []),
    ...(config.tunnel ? [config.tunnel.hostname] : []),
  ])
  const workspaceRoots = validateWorkspaceRoots(config.workspaces ?? [])
  const log = createLogger(config.logLevel, resolveLogSink(config.logFile))
  const rateLimiter = createRateLimiter()
  // Behind the tunnel every request is from loopback; budgets follow the
  // device Cloudflare names instead, apart from local traffic.
  const budgetKey = createBudgetKey(config.tunnel?.hostname)
  // Replaced whole when the environment is renamed: everything below reads
  // its name when it needs it, never a copy taken at boot.
  let identity = await loadEnvironmentIdentity(config.dataDir)
  const platform = detectEnvironmentPlatform()
  const environmentRecord = () => ({
    environmentId: identity.environmentId,
    name: identity.label,
    ...(platform ? { platform } : {}),
  })
  const audit = createAuditLog(log, { dataDir: config.dataDir })
  const environmentSettings = openEnvironmentSettings(config.dataDir)
  const filesystem = createFilesystemService({ settings: environmentSettings })
  let announceClients: () => void = () => undefined
  const clients = openAuthorizedClients(config.dataDir, Date.now, audit, () => announceClients())
  // Local first run needs no pairing UI: the process mints the owner credential.
  // Reminting is explicit (`--remint-owner` or `remintOwner()`), not a restart side effect.
  let owner = clients.ensureOwner()
  if (config.remintOwner) {
    const previousId = owner.clientId
    owner = clients.remintOwner().client
    audit.record({
      type: 'owner.reminted',
      clientId: owner.clientId,
      details: { previousClientId: previousId },
    })
  }
  let closeWorkspaceSessions: (workspaceId: string) => void = () => undefined
  let runnableProviders: () => readonly string[] = () => []
  // Follows every committed workspace record: bound once the registry and
  // the runtime exist, which both commit through the event service.
  let followWorkspaceRecord: (record: DurableEvent) => void = () => undefined
  const eventDatabase = openEnvironmentDatabase(config.dataDir)
  const messageSearch = createMessageSearch({ database: eventDatabase })
  const sessionRowExists = eventDatabase.prepare('SELECT 1 FROM sessions WHERE session_id = ?')
  const sessionActivityRow = eventDatabase.prepare(
    'SELECT updated_at FROM sessions WHERE session_id = ?',
  )
  // Before anything is appended: events stored in an older format are no
  // longer replayed (docs/sync-foundations.md §4.7.7).
  const floorsRaised = raiseReplayFloors(eventDatabase)
  if (floorsRaised > 0)
    log('info', 'replay floors raised for a new event format', { streams: floorsRaised })
  // One epoch per process for streams that start here; replay reads it for
  // scopes that have no stream row yet.
  const eventEpoch = randomUUID()
  // Everything sent outside a command's answer leaves through this one
  // queue, in the order it happened: records in commit order (I4),
  // transients after the record they followed, provider health and the
  // device list among them (docs/sync-foundations.md §5.2). The socket
  // server sends each item and closes any connection it cannot send to, so
  // nothing is skipped; an answer drains the queue first.
  const deliveries = createDeliveryQueue({
    onError: (error, item) =>
      log('error', 'the delivery queue could not send an item', {
        kind: item.kind,
        reason: String(error),
      }),
  })
  const eventService = createPersistentEventService(
    eventDatabase,
    (record) => {
      // The registry's cache follows committed rows at once, not when the
      // queue drains: a command reads its own result right after its write.
      if (record.event.name.startsWith('workspace.')) followWorkspaceRecord(record)
      deliveries.enqueue({ kind: 'record', record })
    },
    {
      epoch: eventEpoch,
      deliverTransient: (event, after) => deliveries.enqueue({ kind: 'transient', event, after }),
      onError: (error) => log('error', 'event persistence failed', { reason: String(error) }),
      // A producer emitted what its projection refuses: a bug. The write is
      // dropped so it cannot block every write behind it (write-errors.ts).
      onRefused: (error, event) =>
        log('error', 'a refused write was dropped', {
          event: event.name,
          eventId: event.eventId,
          reason: String(error),
        }),
      ...config.commitHooks,
    },
  )
  // Profiles and workspace preferences: rows the projection writes, read
  // through the event connection (docs/sync-foundations.md §4.7.11).
  const composerStore = openComposerStore({
    database: eventDatabase,
    environmentId: identity.environmentId,
    appendAtomic: (events) => eventService.appendAtomic(events),
  })
  let workspaces
  try {
    workspaces = openWorkspaceRegistry(
      {
        database: eventDatabase,
        environmentId: identity.environmentId,
        appendAtomic: (events) => eventService.appendAtomic(events),
        flush: eventService.flush,
      },
      workspaceRoots,
      audit,
      {
        onUnregister: (workspaceId) => closeWorkspaceSessions(workspaceId),
        onObservationError: (workspaceId, error) =>
          log('error', 'workspace observation was not saved', {
            workspaceId,
            reason: String(error),
          }),
      },
    )
  } catch (error) {
    eventService.close()
    eventDatabase.close()
    environmentSettings.close()
    clients.close()
    audit.close()
    throw error
  }
  // Production routes every workspace through the registry: an ID resolves to
  // its canonical root or to nothing. The test seam may substitute a provider.
  const resolveWorkspace: WorkspaceRuntimeResolver =
    config.resolveWorkspace ??
    ((workspaceId, context) => {
      const workspace = workspaces.resolve(workspaceId, context)
      if (!workspace) return undefined
      return {
        providerId: 'opencode',
        providers: runnableProviders(),
        cwd: workspace.root,
        // "Last used" means a session actually started here, not merely was
        // asked for. The stamp is bookkeeping: a failure is logged, never fatal.
        onSessionStarted: () => {
          try {
            workspaces.markUsed(workspace.workspaceId)
          } catch (error) {
            log('warn', 'workspace last-used stamp failed', {
              workspaceId: workspace.workspaceId,
              reason: error instanceof Error ? error.message : 'unknown',
            })
          }
        },
      }
    })
  // Pull requests linked to sessions, and the environment's own MCP tools
  // agents link them with. Both outlive no listener: the port and the client
  // count are read when asked, once the socket server exists.
  let anyClientConnected = () => false
  let listeningPort = () => config.port
  const pullRequests = createPullRequestService({
    database: eventDatabase,
    github: config.github ?? createGitHubReader({ token: createGitHubToken() }),
    environmentId: () => identity.environmentId,
    appendAtomic: (events, options) => eventService.appendAtomic(events, options),
    flush: () => eventService.flush(),
    anyClientConnected: () => anyClientConnected(),
    log,
  })
  const agentTools = createAgentToolsEndpoint({
    serverName: 'openmanager',
    tools: pullRequests.tools,
    port: () => listeningPort(),
    version: serverVersion(),
    log,
  })
  let onRuntimeEvent: HostDeps['emitEvent'] = () => undefined
  // What a message queued now would run with; the composer service answers
  // once it exists, and nothing can queue before then.
  let queuedSelection: NonNullable<HostDeps['desiredSessionConfig']> = () => undefined
  // Until the composer service exists only the workspace preference can answer.
  let desiredConfigFor: NonNullable<HostDeps['desiredSessionConfig']> = ({
    providerId,
    workspacePath,
  }) => desiredSessionConfig(composerStore.getPreference(workspacePath, providerId))
  const runtime = mountAgentRuntime(
    log,
    (event) => onRuntimeEvent(event),
    (args) => desiredConfigFor(args),
    config.runtimeOptions,
    agentTools.host,
  )
  let observeProviderCatalog: (providerId: string, result: RuntimeProviderBootstrap) => void = () =>
    undefined
  // Usage limits (CAL-242): Claude Code only for now. Read in a throwaway CLI
  // in the most recent project, or the home directory before there is one.
  const providerLimitsStore = openProviderLimitsStore(config.dataDir)
  const providerLimits = createProviderLimits({
    providerIds: Object.keys(providers),
    supports: (providerId) =>
      config.probeProviders === true &&
      providers[providerId as keyof typeof providers]?.kind === 'claude',
    read: (providerId) =>
      runtime.readUsageLimits({
        providerId: providerId as keyof typeof providers,
        threadId: `usage-limits:${providerId}`,
        cwd: workspaces.mostRecent()?.root ?? homedir(),
      }),
    store: providerLimitsStore,
    log,
  })
  const providerService = createProviderService(
    runtime,
    providers,
    (providerId, result) => observeProviderCatalog(providerId, result),
    resolveWorkspace,
    (providerId) => providerLimits.get(providerId),
  )
  // Broader than provider health's `available`: an unprobed provider is still runnable, so an
  // explicit create only fails for a provider the server would reject anyway.
  runnableProviders = () =>
    providerService
      .snapshot()
      .filter(({ id }) => providerService.rejection(id) === undefined)
      .map(({ id }) => id)
  const replayReader = createReplayReader(eventDatabase, {
    epoch: eventEpoch,
    environment: environmentRecord,
    workspaces: () => workspaces.list(),
    log,
  })
  const stopRetention = createEventRetention(eventDatabase).schedule({
    onError: (error) => log('error', 'event retention failed', { reason: String(error) }),
  })
  // Health probes spawn a provider's CLI, which needs a real directory. No
  // client has to name one first: the registry already knows where the user
  // last worked. Every registry change is announced, so following the
  // announcements keeps this current as folders are added, used and removed.
  const syncProbeDirectory = () => {
    if (config.probeProviders) runtime.setDefaultProbeCwd(workspaces.mostRecent()?.root)
  }
  followWorkspaceRecord = (record) => {
    workspaces.apply(record.event)
    syncProbeDirectory()
  }
  let recordSessionMode: (sessionId: string, modeId: string) => void = () => undefined
  let launchPreference: (
    workspaceId: string,
    providerId: string,
    picks?: WorkspaceComposerPreference,
  ) => WorkspaceComposerPreference = () => {
    throw new Error('The composer service is not ready.')
  }
  let seedSessionComposer: (
    sessionId: string,
    selection: Pick<WorkspaceComposerPreference, 'modelId' | 'configValues'>,
  ) => void = () => undefined
  const artifacts = createArtifactStore(eventDatabase, config.dataDir)
  const drafts = createDraftService({
    database: eventDatabase,
    environmentId: () => identity.environmentId,
    appendAtomic: (events) => eventService.appendAtomic(events),
    discardImages: (artifactIds) => {
      const freed = artifacts.discardHeld(artifactIds)
      if (freed.length > 0) log('info', 'freed images of a deleted draft', { count: freed.length })
    },
  })
  try {
    drafts.pruneTombstones()
  } catch (error) {
    // Left for the next start; an old tombstone only refuses a stale save.
    log('error', 'old draft tombstones were not pruned', { reason: String(error) })
  }
  const titles =
    config.titleGenerator ??
    (config.generateTitles
      ? createTitleGenerator({
          setting: () => environmentSettings.get().titleGeneration,
          log: (level, message, data) => log(level, message, data),
        })
      : undefined)
  const toolOutputOf = createToolOutputReader(eventDatabase)
  const readToolOutput = (sessionId: string, toolCallId: string) => {
    eventService.flush()
    return toolOutputOf(sessionId, toolCallId)
  }
  const threadService = createThreadService(
    runtime,
    providerService,
    (event) => eventService.append(event),
    (event) => eventService.publishTransient(event),
    resolveWorkspace,
    {
      database: eventDatabase,
      artifacts,
      flush: eventService.flush,
      head: (scope) => eventService.repository.head(scope),
      appendAtomic: (events, options) => eventService.appendAtomic(events, options),
      finalizeNow: (event) => eventService.finalizeNow(event),
      onPersistenceError: (error, eventName) =>
        log('error', 'event persistence failed', { eventName, reason: String(error) }),
      workspaceAvailability: (workspaceId) => workspaces.availability(workspaceId),
      onSessionMode: (sessionId, modeId) => recordSessionMode(sessionId, modeId),
      launchPreference: (workspaceId, providerId, picks) =>
        launchPreference(workspaceId, providerId, picks),
      seedSessionComposer: (sessionId, selection) => seedSessionComposer(sessionId, selection),
      drafts,
      ...(titles ? { titles } : {}),
      onTitleFailure: (sessionId, error) =>
        log('warn', 'session title was not generated', { sessionId, reason: String(error) }),
      queuedSettings: ({ providerId, workspaceId, threadId }) => {
        const desired = queuedSelection({ providerId, workspacePath: workspaceId, threadId })
        return {
          ...(desired?.modelId ? { modelId: desired.modelId } : {}),
          ...(desired?.values ? { configValues: desired.values } : {}),
        }
      },
      onQueueProblem: (message, data) => log('warn', message, data),
      watchToolInput: (input) => pullRequests.wantsToolInput(input),
      onWatchedToolSettled: ({ sessionId, toolCallId, text }) =>
        // After the settling update is appended, so its stored text is there to read.
        setImmediate(() => {
          try {
            const output = text ?? readToolOutput(sessionId, toolCallId)?.text
            if (output !== undefined) pullRequests.observeSettledTool({ sessionId, output })
          } catch (error) {
            log('warn', 'a settled gh pr create was not read', { reason: String(error) })
          }
        }),
    },
  )
  closeWorkspaceSessions = (workspaceId) => {
    // Flush before the registry cascades deletion of the projected thread rows.
    eventService.flush()
    threadService.closeWorkspaceSessions(workspaceId)
  }
  const composerService = createComposerService(
    runtime,
    providerService,
    composerStore,
    (sessionId, context) => threadService.resolveRuntimeSession(sessionId, context),
    {
      // Composer changes ride the environment stream, so every client sees
      // them live and a reconnect replays whatever it missed. A chat's listing
      // rides its thread: only a browser with that chat open wants it.
      publish: (name, payload) =>
        eventService.append({
          type: 'event',
          name,
          eventId: randomUUID(),
          timestamp: new Date().toISOString(),
          scope: { type: 'environment', environmentId: identity.environmentId },
          payload,
        } as ProofEvent),
      publishThreadListing: ({ sessionId, threadId }, changed) =>
        eventService.append({
          type: 'event',
          name: 'thread.listing.updated',
          eventId: randomUUID(),
          timestamp: new Date().toISOString(),
          scope: { type: 'thread', environmentId: identity.environmentId, sessionId, threadId },
          payload: changed,
        }),
      sessionForThread: (threadId) => threadService.sessionForThread(threadId),
      readSessionComposer: (sessionId) => getSessionSummary(eventDatabase, sessionId)?.composer,
      readThreadListing: (threadId) => readThreadListing(eventDatabase, threadId, log),
      readWorkspaceListing: (target) => readWorkspaceListing(eventDatabase, target, log),
      listingTarget: (sessionId) => {
        const session = getSessionSummary(eventDatabase, sessionId)
        return session?.providerId
          ? { workspaceId: session.workspaceId, providerId: session.providerId }
          : undefined
      },
      hasSession: (sessionId) => sessionRowExists.get(sessionId) !== undefined,
      sessionActivity: (sessionId) =>
        (sessionActivityRow.get(sessionId) as { updated_at: number } | undefined)?.updated_at,
    },
  )
  desiredConfigFor = (args) => composerService.desiredFor(args)
  queuedSelection = (args) => composerService.desiredFor(args)
  recordSessionMode = (sessionId, modeId) => composerService.recordSessionMode(sessionId, modeId)
  launchPreference = (workspaceId, providerId, picks) =>
    composerService.launchPreference(workspaceId, providerId, picks)
  seedSessionComposer = (sessionId, selection) => composerService.seedSession(sessionId, selection)
  observeProviderCatalog = (providerId, result) => composerService.observeProbe(providerId, result)
  // Health probes answer to nobody, so nothing above would ever hear what
  // they learn. They are also the only probes a provider no client has opened
  // ever gets.
  runtime.onProviderCatalog((providerId, catalog) =>
    composerService.observeCatalog(providerId, catalog),
  )
  const uploads = createUploadService({
    artifacts,
    dataDir: config.dataDir,
    database: eventDatabase,
    audit,
    log,
    rateLimiter,
    budgetKey,
    authenticate: (credential) => clients.authenticate(credential),
    sessionWorkspace: (sessionId) => {
      // A session created a moment ago may still be in the write batch.
      eventService.flush()
      return getSessionSummary(eventDatabase, sessionId)?.workspaceId
    },
    toolOutput: createToolOutputReader(eventDatabase),
    resolveWorkspace,
  })
  let closeClientSockets: (clientId: string) => void = () => undefined
  const pairing = createPairingService({
    dataDir: config.dataDir,
    audit,
    rateLimiter,
    budgetKey,
    environment: () => ({ environmentId: identity.environmentId, label: identity.label }),
    onGrantChanged: (clientId) => closeClientSockets(clientId),
    onClientsChanged: () => announceClients(),
    onError: (error) => log('error', 'pairing exchange failed', { reason: String(error) }),
  })
  threadService.setEnvironmentId(identity.environmentId)
  // Before anything listens: turns the last process left open, and children
  // that turns which ended long ago left open, are closed with events
  // (docs/sync-foundations.md §4.1, §4.2).
  eventService.flush()
  const reconciled = reconcileAfterRestart(
    eventDatabase,
    eventService.repository,
    identity.environmentId,
  )
  for (const failure of reconciled.failures) {
    log('error', `boot ${failure.kind} failed; left for the next start`, {
      ...failure.ids,
      reason: failure.reason,
    })
  }
  if (reconciled.eventsWritten > 0) {
    log('info', 'boot reconcile closed what the last process left open', {
      turnsRecovered: reconciled.turnsRecovered,
      toolsCancelled: reconciled.toolsCancelled,
      thoughtsClosed: reconciled.thoughtsClosed,
      questionsCancelled: reconciled.questionsCancelled,
      threadsRepaired: reconciled.threadsRepaired,
      eventsWritten: reconciled.eventsWritten,
      durationMs: reconciled.durationMs,
    })
  }
  try {
    threadService.forgetStaleBackgroundWork()
  } catch (error) {
    // Left for the next start; a stale "running" is wrong but harmless.
    log('error', 'stale background work was not cleared', { reason: String(error) })
  }
  try {
    threadService.pauseQueuesAfterRestart()
  } catch (error) {
    // A queue left unpaused still waits: nothing drains until a turn ends.
    log('error', 'chat queues were not paused after the restart', { reason: String(error) })
  }
  onRuntimeEvent = (event) => {
    if (event.event === 'usage_limits_update') providerLimits.observe(event.providerId, event.data)
    composerService.onRuntimeEvent(event)
    threadService.onRuntimeEvent(event)
  }
  // Set after listen so port 0 advertises the actual port selected by the OS.
  let websocketUrl: string
  // This process, as opposed to the environment: a client that reconnects to
  // a new one reopens its active chat (docs/sync-foundations.md §4.7.3).
  const instanceId = randomUUID()
  const bootstrap = () =>
    BootstrapResponseSchema.parse({
      instanceId,
      environmentId: identity.environmentId,
      label: identity.label,
      ...(platform ? { platform } : {}),
      protocolVersion: PROTOCOL_VERSION,
      capabilities: SERVER_CAPABILITIES,
      providers: providerService.snapshot(),
      websocketUrl,
    })
  const guard = createRequestGuard({
    allowedOrigins,
    allowedHosts,
    port: () => (server.address() as AddressInfo | null)?.port ?? config.port,
    audit,
  })
  const server = createServer((request, response) => {
    response.setHeader('Vary', 'Origin')
    const rejection = guard.check(request)
    if (rejection) {
      response.writeHead(rejection.status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      })
      response.end(
        JSON.stringify({
          type: 'error',
          requestId: null,
          error: { code: rejection.code, message: rejection.message },
        }),
      )
      return
    }
    if (request.headers.origin !== undefined) {
      response.setHeader('Access-Control-Allow-Origin', request.headers.origin)
    }
    const path = request.url?.split('?')[0]
    if (request.method === 'OPTIONS' && path === LOCAL_OWNER_PATH) {
      const access = config.localOwnerClaimKey
        ? evaluateLocalOwnerRouteAccess(
            request,
            (server.address() as AddressInfo | null)?.port ?? config.port,
          )
        : 'not_found'
      if (access !== 'ok') {
        response.writeHead(access === 'forbidden' ? 403 : 404, {
          'cache-control': 'no-store',
        })
        response.end()
        return
      }
      response.writeHead(204, {
        'access-control-allow-methods': 'GET',
        'access-control-allow-headers': LOCAL_OWNER_CLAIM_HEADER,
        'access-control-max-age': '600',
        'cache-control': 'no-store',
      })
      response.end()
      return
    }
    if (request.method === 'GET' && path === TUNNEL_CHECK_PATH) {
      handleTunnelCheck(request, response)
      return
    }
    if (uploads.handle(request, response)) return
    if (pairing.handle(request, response)) return
    if (agentTools.handle(request, response)) return
    if (request.method === 'GET' && (path === '/health' || path === '/bootstrap')) {
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      })
      response.end(JSON.stringify(path === '/health' ? { status: 'ok' } : bootstrap()))
      return
    }
    if (request.method === 'GET' && path === LOCAL_OWNER_PATH) {
      const remoteAddress = request.socket.remoteAddress ?? 'unknown'
      const access = evaluateLocalOwnerAccess(
        request,
        (server.address() as AddressInfo | null)?.port ?? config.port,
        config.localOwnerClaimKey,
      )
      if (access === 'not_found') {
        audit.record({
          type: 'owner.claim_denied',
          remoteAddress,
          details: { reason: 'not_local_claim', host: auditValue(request.headers.host) },
        })
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        response.end('Not found\n')
        return
      }
      const lockout = rateLimiter.blocked('local_owner', remoteAddress)
      if (!lockout.allowed) {
        audit.record({
          type: 'rate_limited',
          remoteAddress,
          details: { policy: 'local_owner', retryAfterMs: lockout.retryAfterMs },
        })
        response.writeHead(429, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'retry-after': String(Math.ceil(lockout.retryAfterMs / 1000)),
        })
        response.end(
          JSON.stringify({
            type: 'error',
            requestId: null,
            error: { code: 'unavailable', message: 'Too many local owner requests.' },
          }),
        )
        return
      }
      rateLimiter.consume('local_owner', remoteAddress)
      if (access === 'forbidden') {
        audit.record({
          type: 'owner.claim_denied',
          remoteAddress,
          details: { reason: 'origin', origin: auditValue(request.headers.origin) },
        })
        response.writeHead(403, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
        response.end(
          JSON.stringify({
            type: 'error',
            requestId: null,
            error: {
              code: 'auth',
              message: 'Local owner issuance requires a first-party loopback origin.',
            },
          }),
        )
        return
      }
      const credential = clients.publishedOwner()
      if (credential === undefined) {
        response.writeHead(503, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
        response.end(
          JSON.stringify({
            type: 'error',
            requestId: null,
            error: { code: 'unavailable', message: 'Owner credential is not published.' },
          }),
        )
        return
      }
      audit.record({
        type: 'owner.claimed',
        clientId: owner.clientId,
        remoteAddress,
        details: { origin: auditValue(request.headers.origin) },
      })
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      })
      response.end(
        JSON.stringify({
          environmentId: identity.environmentId,
          label: identity.label,
          kind: 'owner',
          grant: owner.capabilities,
          credential,
        }),
      )
      return
    }
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('Not found\n')
  })
  /**
   * The arrival end of the tunnel's hostname check. It reveals nothing: the
   * nonce of a check in flight gets an empty 204, anything else the same 404
   * as an unknown path. Only requests through the tunnel can match, and
   * misses spend their own `tunnel_check` budget, never the credential one.
   */
  function handleTunnelCheck(request: IncomingMessage, response: ServerResponse) {
    // The server's own probe is accepted before any budget is looked at:
    // misses from someone behind the same address must not fail the check.
    const nonce = new URL(request.url ?? '/', 'http://check').searchParams.get('nonce')
    const viaTunnel =
      config.tunnel !== undefined &&
      request.headers.host?.trim().toLowerCase() === config.tunnel.hostname
    if (viaTunnel && nonce !== null && tunnel?.acceptArrival(nonce)) {
      response.writeHead(204, { 'cache-control': 'no-store' })
      response.end()
      return
    }
    const key = budgetKey(request)
    const lockout = rateLimiter.blocked('tunnel_check', key)
    if (!lockout.allowed) {
      response.writeHead(429, {
        'cache-control': 'no-store',
        'retry-after': String(Math.ceil(lockout.retryAfterMs / 1000)),
      })
      response.end()
      return
    }
    rateLimiter.consume('tunnel_check', key)
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('Not found\n')
  }
  let clientSockets: ClientSockets | undefined
  const environmentName = createEnvironmentNameService({
    dataDir: config.dataDir,
    identity: () => identity,
    setIdentity: (next) => {
      identity = next
    },
    environment: environmentRecord,
    broadcast: (event) => deliveries.enqueue({ kind: 'broadcast', event }),
    log,
  })
  const clientService = createClientService({
    clients,
    sockets: () => {
      if (!clientSockets) throw new Error('The socket server is not ready.')
      return clientSockets
    },
    uploads,
    rotateOwner: (requestedBy) => {
      const previousId = owner.clientId
      const minted = clients.remintOwner()
      owner = minted.client
      // The rotation has committed: nothing after this may stop the caller
      // from cutting the old credential's sockets.
      try {
        audit.record({
          type: 'owner.reminted',
          clientId: minted.client.clientId,
          details: requestedBy
            ? { previousClientId: previousId, requestedBy }
            : { previousClientId: previousId },
        })
      } catch (error) {
        log('error', 'owner rotation was not audited', { reason: String(error) })
      }
      return { client: minted.client, credential: minted.credential, previousId }
    },
    log,
  })
  announceClients = () => clientService.announce()
  const sockets = attachWebSocket(server, {
    authenticate: (credential) => clients.authenticate(credential),
    guard,
    rateLimiter,
    budgetKey,
    audit,
    bootstrap,
    environmentId: identity.environmentId,
    replay: (scope, cursor) => replayReader.read(scope, cursor),
    dispatchCommand: (command, context) =>
      workspaces.dispatch(command, context) ??
      threadService.dispatch(command, context) ??
      providerService.dispatch(command, context) ??
      providerLimits.dispatch(command) ??
      uploads.dispatch(command, context) ??
      filesystem.dispatch(command, context) ??
      messageSearch.dispatch(command) ??
      pullRequests.dispatch(command) ??
      drafts.dispatch(command, context) ??
      pairing.dispatch(command, context) ??
      clientService.dispatch(command, context) ??
      environmentName.dispatch(command) ??
      composerService.dispatch(command, context),
    onConnectionsChanged: () => clientService.announce(),
    drainDeliveries: () => deliveries.drain(),
    log,
  })
  clientSockets = {
    connectedClientIds: () => sockets.connectedClientIds(),
    hasFollowers: (topic) => sockets.hasFollowers(topic),
    publishToFollowers: (topic, build) => deliveries.enqueue({ kind: 'followers', topic, build }),
    disconnectClient: (clientId) => sockets.disconnectClient(clientId),
  }
  closeClientSockets = (clientId) => {
    sockets.retireClient(clientId, GRANT_CHANGED_CLOSE_CODE, GRANT_CHANGED_CLOSE_REASON)
    // A ticket or transfer was authorized under the old grant; the device asks
    // again under the new one.
    uploads.revokeClient(clientId)
  }
  const stopHealthEvents = providerService.onHealthChanged((event) =>
    deliveries.enqueue({ kind: 'broadcast', event }),
  )
  const stopLimitsEvents = providerLimits.onChanged((event) =>
    deliveries.enqueue({ kind: 'broadcast', event }),
  )
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(config.port, '127.0.0.1', () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
  } catch (error) {
    clientService.stop()
    await sockets.close()
    stopHealthEvents()
    stopLimitsEvents()
    providerLimits.stop()
    providerService.stop()
    composerService.stop()
    await runtime.shutdown()
    stopRetention()
    uploads.close()
    pairing.close()
    eventService.close()
    eventDatabase.close()
    composerStore.close()
    providerLimitsStore.close()
    environmentSettings.close()
    clients.close()
    workspaces.close()
    audit.close()
    throw error
  }
  const address = server.address() as AddressInfo
  websocketUrl = `ws://127.0.0.1:${address.port}/ws`
  listeningPort = () => address.port
  anyClientConnected = () => sockets.connectedClientIds().size > 0
  pullRequests.start()
  // Nothing goes out before the server listens and can describe itself. No
  // client can be connected yet, and durable events stay replayable. Looked
  // up per item, so a test can watch what is sent.
  deliveries.attach((item) => sockets.deliver(item))
  syncProbeDirectory()
  providerService.start()
  // Started only once the listener is up: the connector's one origin is this
  // server's loopback port, and the self-check needs it to answer.
  const tunnelStatusFile = join(config.dataDir, TUNNEL_STATUS_FILE_NAME)
  let tunnel: TunnelSupervisor | undefined
  if (config.tunnel) {
    tunnel = createTunnelSupervisor({
      ...config.tunnelOptions,
      config: config.tunnel,
      port: address.port,
      log,
      statusFile: tunnelStatusFile,
      configFile: join(config.dataDir, CLOUDFLARED_CONFIG_FILE_NAME),
    })
    tunnel.start()
  } else {
    clearTunnelStatus(tunnelStatusFile)
  }
  let closePromise: Promise<void> | undefined
  return {
    get identity() {
      return identity
    },
    get owner() {
      return owner
    },
    clients,
    workspaces,
    audit,
    rateLimiter,
    runtime,
    threadService,
    composerService,
    composerStore,
    pullRequests,
    agentTools,
    environmentSettings,
    uploads,
    pairing,
    sockets,
    /** The tunnel supervisor, when this server runs a tunnel. */
    tunnel,
    port: address.port,
    url: `http://127.0.0.1:${address.port}`,
    /** Revoke a client's credential and cut its live sockets in one step. */
    revokeClient(clientId: string): boolean {
      if (clientId === owner.clientId) return false
      return clientService.revoke(clientId)
    },
    /**
     * Replace the owner credential. The previous owner row is revoked and its
     * live sockets close; the new credential is published in the data directory.
     */
    remintOwner() {
      const { client, credential } = clientService.rotateOwner()
      return { client, credential }
    },
    close: () => {
      if (!closePromise) {
        clientService.stop()
        const socketClose = sockets.close()
        // Before the listener: an in-flight PUT is cut and its partial file removed.
        uploads.close()
        // Before the store closes: a pending model lookup retry must not fire into it.
        composerService.stop()
        const httpClose = new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()))
          server.closeAllConnections()
        })
        closePromise = Promise.all([
          socketClose,
          httpClose,
          runtime.shutdown(),
          threadService.stopTitles(),
          tunnel?.stop(),
        ]).then(() => {
          stopRetention()
          pairing.close()
          eventService.close()
          eventDatabase.close()
          composerStore.close()
          providerLimitsStore.close()
          environmentSettings.close()
          clients.close()
          workspaces.close()
          audit.close()
        })
        stopHealthEvents()
        stopLimitsEvents()
        providerLimits.stop()
        providerService.stop()
        pullRequests.stop()
      }
      return closePromise
    },
  }
}
