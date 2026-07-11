import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'
import type {
  AgentEvent,
  AuthMethod,
  ContentBlock,
  ModeListing,
  ModelListing,
  PermissionOption,
  PermissionOutcome,
  ProviderId,
  SessionConfigOption,
  ToolCallContent,
} from '@agentpack/contract'
import type { HostDeps } from '../../host.js'
import type { ProviderConfig } from '../../providers/index.js'
import { PermissionBroker } from '../../core/PermissionBroker.js'
import { SessionStore } from '../../core/SessionStore.js'
import { AuthRequiredError } from '../../core/errors.js'
import type {
  Backend,
  BackendEvent,
  BackendEventListener,
  BackendRoute,
  BackendSessionArgs,
  SessionResult,
} from '../Backend.js'
import { ExtensionRegistry } from './extensions.js'

type RecordValue = Record<string, unknown>
const object = (value: unknown): RecordValue =>
  value && typeof value === 'object' ? (value as RecordValue) : {}
const string = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined
const number = (value: unknown): number | undefined =>
  typeof value === 'number' ? value : undefined
const sessionIdOf = (value: unknown): string | undefined => {
  const p = object(value)
  return (
    string(p.sessionId) ??
    string(object(p._meta).sessionId) ??
    string(object(p.toolCall).sessionId) ??
    string(object(p.update).sessionId)
  )
}
const errorCode = (error: unknown): number | undefined => number(object(error).code)
const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : 'ACP operation failed'
const isAuthRequired = (error: unknown): boolean => errorCode(error) === -32002

function normalizeModelListing(value: unknown): ModelListing {
  const listing = object(value)
  const availableModels = Array.isArray(listing.availableModels)
    ? listing.availableModels.flatMap((value) => {
        const model = object(value)
        const id = string(model.modelId) ?? string(model.id)
        if (!id) return []
        return [
          {
            id,
            displayName: string(model.name) ?? string(model.displayName) ?? id,
            ...(string(model.description) !== undefined
              ? { description: string(model.description) }
              : {}),
          },
        ]
      })
    : undefined

  return {
    ...(string(listing.currentModelId) !== undefined
      ? { currentModelId: string(listing.currentModelId) }
      : {}),
    ...(availableModels !== undefined ? { availableModels } : {}),
  }
}

function normalizeModeListing(value: unknown): ModeListing {
  const listing = object(value)
  const availableModes = Array.isArray(listing.availableModes)
    ? listing.availableModes.flatMap((value) => {
        const mode = object(value)
        const id = string(mode.id)
        if (!id) return []
        return [
          {
            id,
            displayName: string(mode.name) ?? string(mode.displayName) ?? id,
            ...(string(mode.description) !== undefined
              ? { description: string(mode.description) }
              : {}),
          },
        ]
      })
    : undefined

  return {
    ...(string(listing.currentModeId) !== undefined
      ? { currentModeId: string(listing.currentModeId) }
      : {}),
    ...(availableModes !== undefined ? { availableModes } : {}),
  }
}

function modelListingFromConfig(options: readonly SessionConfigOption[]): ModelListing | undefined {
  const control = options.find(
    (option) =>
      option.type === 'select' &&
      (option.category === 'model' || option.name.toLowerCase().includes('model')),
  )
  if (!control || control.type !== 'select') return undefined
  return {
    currentModelId: control.currentValue,
    availableModels: control.options.map((option) => ({
      id: option.value,
      displayName: option.name,
      ...(option.description ? { description: option.description } : {}),
    })),
  }
}

function modeListingFromConfig(options: readonly SessionConfigOption[]): ModeListing | undefined {
  const control = options.find(
    (option) =>
      option.type === 'select' &&
      (option.category === 'mode' || option.name.toLowerCase().includes('mode')),
  )
  if (!control || control.type !== 'select') return undefined
  return {
    currentModeId: control.currentValue,
    availableModes: control.options.map((option) => ({
      id: option.value,
      displayName: option.name,
      ...(option.description ? { description: option.description } : {}),
    })),
  }
}

function contentBlock(value: unknown): ContentBlock {
  const v = object(value)
  const type = string(v.type)
  if (type === 'text') return { type, text: string(v.text) ?? '' }
  if (type === 'image' || type === 'audio')
    return {
      type,
      mimeType: string(v.mimeType) ?? 'application/octet-stream',
      data: string(v.data) ?? '',
    }
  if (type === 'resource_link')
    return { type, uri: string(v.uri) ?? '', name: string(v.name), mimeType: string(v.mimeType) }
  if (type === 'resource')
    return {
      type,
      uri: string(v.uri),
      mimeType: string(v.mimeType),
      text: string(v.text),
      data: string(v.data),
    }
  return { type: 'text', text: string(v.text) ?? '' }
}

function toolContent(value: unknown): ToolCallContent {
  const v = object(value)
  const type = string(v.type)
  if (type === 'diff')
    return {
      type,
      path: string(v.path) ?? '',
      oldText: string(v.oldText) ?? null,
      newText: string(v.newText) ?? '',
    }
  if (type === 'terminal') return { type, terminalId: string(v.terminalId) ?? '' }
  return { type: 'content', content: contentBlock(v.content) }
}

function routeEvent(
  route: BackendRoute,
  sessionId: string | undefined,
  category: AgentEvent['category'],
  event: AgentEvent['event'],
  data: unknown,
): BackendEvent {
  return { ...route, sessionId, category, event, data } as BackendEvent
}

export class AcpBackend implements Backend {
  readonly providerId: ProviderId
  private process: ChildProcessWithoutNullStreams | null = null
  private connection: acp.ClientSideConnection | null = null
  private initialized = false
  private authenticated = false
  private bootstrap: Promise<void> | null = null
  private expectedExit = false
  private readonly listeners = new Set<BackendEventListener>()
  private readonly sessions = new SessionStore()
  private readonly permissions = new PermissionBroker()
  private readonly extensions: ExtensionRegistry

  constructor(
    private readonly config: ProviderConfig,
    private readonly host: Pick<HostDeps, 'log' | 'onSessionTitle'>,
  ) {
    this.providerId = config.id
    this.extensions = new ExtensionRegistry(config.extensions)
  }
  events(listener: BackendEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  private emit(event: BackendEvent): void {
    for (const listener of this.listeners) listener(event)
  }
  private logInbound(method: string, data: unknown): void {
    this.host.log({
      scope: 'acp',
      level: 'info',
      message: `[event] <- ${method}`,
      data,
    })
  }
  private emitAll(
    category: AgentEvent['category'],
    event: AgentEvent['event'],
    data: unknown,
  ): void {
    for (const b of this.sessions.bindings())
      this.emit(routeEvent(b, b.sessionId, category, event, data))
  }
  private conn(): acp.ClientSideConnection {
    if (!this.connection) throw new Error(`ACP runtime unavailable for ${this.providerId}`)
    return this.connection
  }
  private alive(): boolean {
    return Boolean(this.process && this.connection && this.process.exitCode === null)
  }

  async start(args: BackendRoute & { cwd: string }): Promise<void> {
    if (!this.alive()) this.spawn(args)
    if (this.initialized && this.authenticated) return
    if (this.bootstrap) return this.bootstrap
    this.bootstrap = this.handshake(args).finally(() => {
      this.bootstrap = null
    })
    return this.bootstrap
  }

  private spawn(route: BackendRoute & { cwd: string }): void {
    this.sessions.nextGeneration()
    this.expectedExit = false
    const command =
      process.env[this.config.command.envOverride] ??
      (this.config.command.fallbackEnvOverride
        ? process.env[this.config.command.fallbackEnvOverride]
        : undefined) ??
      this.config.command.bin
    const child = spawn(command, this.config.command.args, {
      cwd: route.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    })
    this.process = child
    this.emit(
      routeEvent(route, undefined, 'lifecycle', 'process_spawned', {
        cwd: route.cwd,
        command,
        args: this.config.command.args,
        processId: child.pid,
      }),
    )
    const client: acp.Client = {
      requestPermission: async (params) => this.permissionRequest(params),
      sessionUpdate: async (params) => this.sessionUpdate(params),
      extMethod: async (method, params) => this.extensionRequest(method, params),
      extNotification: async (method, params) => this.extensionNotification(method, params),
    }
    this.connection = new acp.ClientSideConnection(
      () => client,
      acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout) as any),
    )
    this.initialized = false
    this.authenticated = false
    child.stderr.on('data', (data) =>
      this.host.log({
        scope: 'acp',
        level: 'warn',
        message: 'ACP stderr output',
        data: { providerId: this.providerId, text: String(data) },
      }),
    )
    child.on('error', (error) =>
      this.emitAll('error', 'runtime_error', {
        kind: 'process',
        message: error.message,
        recoverable: true,
      }),
    )
    child.on('exit', (code, signal) => {
      this.emitAll('lifecycle', 'process_exited', {
        exitCode: code,
        signal: signal ?? undefined,
        expected: this.expectedExit,
      })
      this.permissions.settleProvider(this.providerId)
      this.process = null
      this.connection = null
      this.initialized = false
      this.authenticated = false
      this.bootstrap = null
      this.sessions.clear()
    })
  }

  private async handshake(route: BackendRoute): Promise<void> {
    let response: RecordValue
    try {
      response = object(
        await this.conn().initialize({
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: { name: '@agentpack/runtime', version: '0.1.0' },
        }),
      )
    } catch (error) {
      if (isAuthRequired(error)) throw this.authRequired(route, undefined, errorMessage(error))
      throw error
    }
    this.initialized = true
    const methods = Array.isArray(response.authMethods)
      ? response.authMethods
          .map((v): AuthMethod => {
            const m = object(v)
            return {
              id: string(m.id) ?? string(m.methodId) ?? '',
              displayName:
                string(m.name) ?? string(m.displayName) ?? string(m.id) ?? 'Authentication',
              description: string(m.description),
            }
          })
          .filter((m) => m.id)
      : []
    const rawAgent = object(response.agentInfo)
    const agentInfo = string(rawAgent.name)
      ? { name: string(rawAgent.name)!, version: string(rawAgent.version) }
      : undefined
    this.emit(
      routeEvent(route, undefined, 'lifecycle', 'initialized', {
        protocolVersion: string(response.protocolVersion),
        agentInfo,
        capabilities: this.config.capabilities,
        authMethods: methods,
      }),
    )
    const methodId = this.pickAuthMethod(methods)
    if (!methodId) {
      this.authenticated = true
      return
    }
    try {
      await this.conn().authenticate({ methodId })
      this.authenticated = true
      this.emit(routeEvent(route, undefined, 'lifecycle', 'authenticated', { methodId }))
    } catch (error) {
      const authError = this.authRequired(route, methods, errorMessage(error))
      if (!this.config.auth.tolerateAuthenticateFailure) throw authError
      this.authenticated = true
    }
  }

  private pickAuthMethod(methods: AuthMethod[]): string | undefined {
    for (const hint of this.config.auth.methodHints) {
      const match =
        methods.find((m) => m.id === hint) ??
        methods.find((m) => m.id.toLowerCase().includes(hint.toLowerCase()))
      if (match) return match.id
    }
    return methods[0]?.id
  }
  private authRequired(
    route: BackendRoute,
    methods: AuthMethod[] | undefined,
    message: string,
  ): AuthRequiredError {
    this.emit(
      routeEvent(route, undefined, 'error', 'auth_required', {
        message,
        authMethods: methods,
        loginHint: this.config.auth.loginInstruction,
      }),
    )
    return new AuthRequiredError(this.providerId, message, this.config.auth.loginInstruction)
  }

  async ensureSession(args: BackendSessionArgs): Promise<SessionResult> {
    await this.start(args)
    const active = this.sessions.forThread(args.threadId)
    if (active)
      return { sessionId: active.sessionId, state: 'reused', resumeCursor: active.resumeCursor }
    if (args.sessionId && this.config.capabilities.canLoadSession) {
      try {
        const response = object(
          await this.conn().loadSession({
            sessionId: args.sessionId,
            cwd: args.cwd,
            mcpServers: [],
          }),
        )
        this.sessions.bind({
          providerId: this.providerId,
          threadId: args.threadId,
          workspaceId: args.workspaceId,
          sessionId: args.sessionId,
          resumeCursor: args.resumeCursor,
        })
        this.emit(
          routeEvent(
            args,
            args.sessionId,
            'lifecycle',
            'session_loaded',
            this.initialState(response),
          ),
        )
        return { sessionId: args.sessionId, state: 'loaded', resumeCursor: args.resumeCursor }
      } catch (error) {
        if (isAuthRequired(error)) throw this.authRequired(args, undefined, errorMessage(error))
        this.host.log({
          scope: 'acp',
          level: 'warn',
          message: 'Stored ACP session could not be loaded; creating a new session',
          data: { sessionId: args.sessionId, error: errorMessage(error) },
        })
      }
    }
    try {
      const response = object(await this.conn().newSession({ cwd: args.cwd, mcpServers: [] }))
      const sessionId = string(response.sessionId)
      if (!sessionId) throw new Error('ACP session/new returned no sessionId')
      this.sessions.bind({
        providerId: this.providerId,
        threadId: args.threadId,
        workspaceId: args.workspaceId,
        sessionId,
        resumeCursor: args.resumeCursor,
      })
      this.emit(
        routeEvent(args, sessionId, 'lifecycle', 'session_created', this.initialState(response)),
      )
      return { sessionId, state: 'created', resumeCursor: args.resumeCursor }
    } catch (error) {
      if (isAuthRequired(error)) throw this.authRequired(args, undefined, errorMessage(error))
      throw error
    }
  }

  private initialState(response: RecordValue): unknown {
    const configOptions = Array.isArray(response.configOptions)
      ? (response.configOptions as SessionConfigOption[])
      : []
    const directModels = normalizeModelListing(response.models)
    const directModes = normalizeModeListing(response.modes)
    return {
      models:
        directModels.currentModelId || directModels.availableModels
          ? directModels
          : modelListingFromConfig(configOptions),
      modes:
        directModes.currentModeId || directModes.availableModes
          ? directModes
          : modeListingFromConfig(configOptions),
      configOptions,
    }
  }
  async prompt(
    args: BackendRoute & {
      cwd: string
      sessionId: string
      prompt: string
      userMessageId?: string
    },
  ): Promise<void> {
    await this.start(args)
    const userMessageId = args.userMessageId ?? `agent_usr_${crypto.randomUUID()}`
    this.emit(
      routeEvent(args, args.sessionId, 'lifecycle', 'prompt_started', {
        prompt: args.prompt,
        userMessageId,
      }),
    )
    try {
      const result = object(
        await this.conn().prompt({
          sessionId: args.sessionId,
          prompt: [{ type: 'text', text: args.prompt }],
        }),
      )
      this.emit(
        routeEvent(args, args.sessionId, 'lifecycle', 'prompt_completed', {
          stopReason: string(result.stopReason),
          usage: result.usage,
        }),
      )
    } catch (error) {
      throw this.rpcError(args, args.sessionId, 'session/prompt', error)
    }
  }
  async cancel(args: BackendRoute & { cwd: string; sessionId: string }): Promise<void> {
    await this.start(args)
    this.permissions.cancelThread(this.providerId, args.threadId)
    try {
      await this.conn().cancel({ sessionId: args.sessionId })
    } catch (error) {
      throw this.rpcError(args, args.sessionId, 'session/cancel', error)
    }
  }
  respondPermission(requestId: string, outcome: PermissionOutcome): boolean {
    return this.permissions.respond(requestId, outcome)
  }
  async setModel(
    args: BackendRoute & { cwd: string; sessionId: string; modelId: string },
  ): Promise<void> {
    await this.start(args)
    try {
      await this.conn().unstable_setSessionModel({
        sessionId: args.sessionId,
        modelId: args.modelId,
      })
      this.emit(
        routeEvent(
          args,
          args.sessionId,
          'session',
          'current_model_update',
          normalizeModelListing({ currentModelId: args.modelId }),
        ),
      )
    } catch (error) {
      throw this.rpcError(args, args.sessionId, 'session/set_model', error)
    }
  }
  async setMode(
    args: BackendRoute & { cwd: string; sessionId: string; modeId: string },
  ): Promise<void> {
    await this.start(args)
    try {
      await this.conn().setSessionMode({ sessionId: args.sessionId, modeId: args.modeId })
    } catch (error) {
      throw this.rpcError(args, args.sessionId, 'session/set_mode', error)
    }
  }
  async setConfigOption(
    args: BackendRoute & {
      cwd: string
      sessionId: string
      configId: string
      value: string | boolean
    },
  ): Promise<void> {
    await this.start(args)
    try {
      const params =
        typeof args.value === 'boolean'
          ? {
              sessionId: args.sessionId,
              configId: args.configId,
              type: 'boolean' as const,
              value: args.value,
            }
          : { sessionId: args.sessionId, configId: args.configId, value: args.value }
      const response = await this.conn().setSessionConfigOption(params)
      this.emit(
        routeEvent(args, args.sessionId, 'session', 'config_option_update', {
          configOptions: response.configOptions as SessionConfigOption[],
        }),
      )
    } catch (error) {
      throw this.rpcError(args, args.sessionId, 'session/set_config_option', error)
    }
  }

  private rpcError(
    route: BackendRoute,
    sessionId: string | undefined,
    source: string,
    error: unknown,
  ): Error {
    if (isAuthRequired(error)) return this.authRequired(route, undefined, errorMessage(error))
    this.emit(
      routeEvent(route, sessionId, 'error', 'rpc_error', {
        source,
        message: errorMessage(error),
        code: errorCode(error),
        details: object(error).data,
      }),
    )
    return error instanceof Error ? error : new Error(errorMessage(error))
  }
  private async permissionRequest(
    params: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    this.logInbound('session/request_permission', params)
    const sessionId = sessionIdOf(params)
    const binding = sessionId ? this.sessions.forSession(sessionId) : undefined
    if (!sessionId || !binding) return { outcome: { outcome: 'cancelled' } }
    const p = object(params)
    const requestId = crypto.randomUUID()
    const tool = object(p.toolCall)
    const options: PermissionOption[] = (Array.isArray(p.options) ? p.options : []).map((v) => {
      const o = object(v)
      return {
        optionId: string(o.optionId) ?? '',
        name: string(o.name) ?? '',
        kind: (string(o.kind) ?? 'reject_once') as PermissionOption['kind'],
      }
    })
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString()
    this.emit(
      routeEvent(binding, sessionId, 'permission', 'permission_request', {
        requestId,
        sessionId,
        toolCall: {
          toolCallId: string(tool.toolCallId) ?? '',
          title: string(tool.title) ?? '',
          kind: string(tool.kind),
          rawInput: tool.rawInput,
        },
        options,
        expiresAt,
      }),
    )
    return new Promise((resolve) =>
      this.permissions.add(requestId, {
        providerId: this.providerId,
        threadId: binding.threadId,
        options,
        resolve,
      }),
    )
  }

  private async sessionUpdate(params: acp.SessionNotification): Promise<void> {
    this.logInbound('session/update', params)
    const p = object(params)
    const sessionId = string(p.sessionId)
    const binding = sessionId ? this.sessions.forSession(sessionId) : undefined
    if (!sessionId || !binding) {
      this.host.log({
        scope: 'acp',
        level: 'warn',
        message: 'Dropping update for unknown ACP session',
        data: { sessionId },
      })
      return
    }
    const update = object(p.update)
    const cursor = string(update.resumeCursor) ?? string(object(update._meta).cursor)
    if (cursor) this.sessions.setResumeCursor(binding.threadId, cursor)
    const kind = string(update.sessionUpdate)
    if (
      kind === 'user_message_chunk' ||
      kind === 'agent_message_chunk' ||
      kind === 'agent_thought_chunk'
    ) {
      this.emit(
        routeEvent(binding, sessionId, 'stream', kind, {
          messageId: string(update.messageId),
          content: contentBlock(update.content),
        }),
      )
      return
    }
    if (kind === 'tool_call') {
      this.emit(
        routeEvent(binding, sessionId, 'tool', 'tool_call', {
          toolCallId: string(update.toolCallId) ?? '',
          title: string(update.title) ?? '',
          kind: update.kind,
          status: update.status,
          rawInput: update.rawInput,
          rawOutput: update.rawOutput,
          content: Array.isArray(update.content) ? update.content.map(toolContent) : undefined,
          locations: update.locations,
          metadata: update._meta,
        }),
      )
      return
    }
    if (kind === 'tool_call_update') {
      const content = Array.isArray(update.content) ? update.content.map(toolContent) : []
      this.emit(
        routeEvent(binding, sessionId, 'tool', 'tool_call_update', {
          toolCallId: string(update.toolCallId) ?? '',
          title: string(update.title),
          kind: update.kind,
          status: update.status,
          rawInput: update.rawInput,
          rawOutput: update.rawOutput,
          content,
          locations: update.locations,
          metadata: update._meta,
        }),
      )
      return
    }
    if (kind === 'plan') {
      if (this.config.quirks.suppressPlanUpdates) {
        /* OpenCode does not expose enough stable tool metadata to identify todo mirrors reliably, so the conservative documented fallback is to suppress every plan update. */ return
      }
      this.emit(
        routeEvent(binding, sessionId, 'session', 'plan_update', {
          entries: update.entries ?? [],
          explanation: update.explanation,
        }),
      )
      return
    }
    if (kind === 'available_commands_update') {
      this.emit(
        routeEvent(binding, sessionId, 'session', 'available_commands_update', {
          availableCommands: update.availableCommands ?? [],
        }),
      )
      return
    }
    if (kind === 'current_mode_update') {
      this.emit(
        routeEvent(
          binding,
          sessionId,
          'session',
          'current_mode_update',
          normalizeModeListing(
            update.modes ?? {
              currentModeId: update.currentModeId,
              availableModes: update.availableModes,
            },
          ),
        ),
      )
      return
    }
    if (kind === 'current_model_update') {
      this.emit(
        routeEvent(
          binding,
          sessionId,
          'session',
          'current_model_update',
          normalizeModelListing(
            update.models ?? {
              currentModelId: update.currentModelId,
              availableModels: update.availableModels,
            },
          ),
        ),
      )
      return
    }
    if (kind === 'config_option_update') {
      this.emit(
        routeEvent(binding, sessionId, 'session', 'config_option_update', {
          configOptions: update.configOptions ?? [],
        }),
      )
      return
    }
    if (kind === 'session_info_update') {
      const title = string(update.title)?.trim()
      this.emit(
        routeEvent(binding, sessionId, 'session', 'session_info_update', {
          title: title ?? null,
          updatedAt: string(update.updatedAt) ?? null,
        }),
      )
      if (title)
        this.host.onSessionTitle?.({
          threadId: binding.threadId,
          workspaceId: binding.workspaceId,
          title,
        })
      return
    }
    if (kind === 'usage_update') {
      this.emit(
        routeEvent(binding, sessionId, 'session', 'usage_update', {
          used: number(update.used) ?? 0,
          size: number(update.size) ?? 0,
          cost: update.cost,
        }),
      )
      return
    }
    this.emit(
      routeEvent(binding, sessionId, 'error', 'rpc_error', {
        source: 'session/update',
        message: `Unknown session update: ${kind ?? 'missing'}`,
        details: update,
      }),
    )
  }
  private async extensionRequest(
    method: string,
    params: unknown,
  ): Promise<Record<string, unknown>> {
    this.logInbound(method, params)
    const sessionId = sessionIdOf(params)
    const binding = sessionId ? this.sessions.forSession(sessionId) : undefined
    if (binding && sessionId)
      this.emit(
        routeEvent(binding, sessionId, 'extension', 'extension_request', {
          requestId: crypto.randomUUID(),
          method,
          params,
        }),
      )
    return object(await this.extensions.request(method, params))
  }
  private async extensionNotification(method: string, params: unknown): Promise<void> {
    this.logInbound(method, params)
    const sessionId = sessionIdOf(params)
    const binding = sessionId ? this.sessions.forSession(sessionId) : undefined
    if (binding && sessionId)
      this.emit(
        routeEvent(binding, sessionId, 'extension', 'extension_notification', { method, params }),
      )
    await this.extensions.notification(method, params)
  }
  dispose(): void {
    this.expectedExit = true
    this.permissions.settleAll()
    if (this.process?.exitCode === null) {
      this.process.kill()
      return
    }
    this.connection = null
    this.process = null
    this.initialized = false
    this.authenticated = false
    this.bootstrap = null
    this.sessions.clear()
  }
}
