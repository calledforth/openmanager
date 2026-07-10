import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import { spawn, type ChildProcess } from 'child_process'
import type { BrowserWindow } from 'electron'
import type { AgentClient, AgentSession } from './agent-client'
import { ACPConnection } from './acp-connection'
import type { SSEBridge } from './sse-bridge'

type PermissionOutcome = {
  outcome: 'selected' | 'dismissed'
  optionId?: string
}

interface PendingPermission {
  sessionId: string
  options?: Array<{ optionId?: string; kind?: string }>
  resolve: (outcome: PermissionOutcome) => void
}

interface StreamingTurn {
  assistantMessageId: string
  parts: Map<string, Record<string, unknown>>
  activeReasoningPartId?: string
  activeTextPartId?: string
}

interface SessionRuntimeSelection {
  currentModelId?: string
  currentModeId?: string
}

interface AcpConfigOption {
  id?: unknown
  category?: unknown
  currentValue?: unknown
  options?: Array<{
    value?: unknown
    name?: unknown
    description?: unknown
  }>
}

interface AcpSessionResult {
  sessionId?: string
  models?: unknown
  modes?: unknown
  configOptions?: AcpConfigOption[]
  _meta?: unknown
}

type RpcError = Error & { code?: number; data?: unknown }

type ToolLifecycleState = 'pending' | 'running' | 'completed' | 'error'

function toolStateRank(status: ToolLifecycleState): number {
  switch (status) {
    case 'pending':
      return 0
    case 'running':
      return 1
    case 'completed':
    case 'error':
      return 2
  }
}

function parseRpcError(error: unknown): RpcError {
  const err = error instanceof Error ? (error as RpcError) : (new Error(String(error)) as RpcError)
  return err
}

export class ACPClient {
  private initialized = false
  private pendingPermissions = new Map<string, PendingPermission>()
  private activeTurns = new Map<string, StreamingTurn>()
  private sessionRuntime = new Map<string, SessionRuntimeSelection>()
  private sessionWorkspace = new Map<string, string>()
  private activeRequestWorkspace: string | null = null
  private terminals = new Map<
    string,
    {
      process: ChildProcess
      output: string
      exited: boolean
      exitCode: number | null
    }
  >()

  constructor(
    private connection: ACPConnection,
    private resolveBridge: (workspacePath: string) => SSEBridge | null,
    private mainWindow: BrowserWindow,
  ) {
    this.connection.onNotification((method, params) => this.handleNotification(method, params))
    this.connection.setRequestHandler((method, params) => this.handleRequest(method, params))
  }

  getWorkspaceClient(workspacePath: string): AgentClient {
    return new ACPWorkspaceClient(this, workspacePath)
  }

  async initialize(): Promise<void> {
    if (this.initialized) return
    const result = await this.connection.call<Record<string, unknown>>('initialize', {
      protocolVersion: 1,
      clientInfo: { name: 'OpenManager', version: '0.1.0' },
      clientCapabilities: {
        fs: {
          readTextFile: true,
          writeTextFile: true,
        },
        terminal: true,
        _meta: { 'terminal-auth': true },
      },
    })
    this.initialized = true
    this.emitAcpEvent('initialize.result', result)
  }

  async createSessionForWorkspace(workspacePath: string, title?: string): Promise<AgentSession> {
    await this.initialize()
    const result = await this.connection.call<AcpSessionResult & { sessionId: string }>(
      'session/new',
      {
        cwd: workspacePath,
        mcpServers: [],
        ...(title ? { title } : {}),
      },
    )
    this.sessionWorkspace.set(result.sessionId, workspacePath)
    const normalizedResult = this.normalizeSessionResult(result)
    this.emitAcpEvent('session.new.result', normalizedResult, workspacePath)
    this.updateSessionRuntimeFromPayload(
      result.sessionId,
      normalizedResult.models,
      normalizedResult.modes,
    )
    await this.syncSessionTitle(result.sessionId).catch(() => undefined)
    return {
      id: result.sessionId,
      title,
      status: 'idle',
      createdAt: new Date().toISOString(),
    }
  }

  async deleteSessionForWorkspace(workspacePath: string, id: string): Promise<void> {
    await this.initialize()
    // OpenCode ACP currently doesn't expose a delete-session RPC method.
    // Project local deletion through the existing SSEBridge -> Convex path.
    this.sessionRuntime.delete(id)
    this.activeTurns.delete(id)
    this.ingestSynthetic('session.deleted', { info: { id } }, workspacePath)
  }

  async loadSessionForWorkspace(workspacePath: string, sessionId: string): Promise<void> {
    await this.initialize()
    // OpenCode replays session/update notifications while session/load is still
    // in flight, so routing must exist before making the request.
    this.sessionWorkspace.set(sessionId, workspacePath)
    const result = await this.connection.call<AcpSessionResult>('session/load', {
      sessionId,
      cwd: workspacePath,
      mcpServers: [],
    })
    const normalizedResult = this.normalizeSessionResult({ sessionId, ...result })
    this.emitAcpEvent('session.load.result', normalizedResult, workspacePath)
    this.updateSessionRuntimeFromPayload(sessionId, normalizedResult.models, normalizedResult.modes)
    await this.syncSessionTitle(sessionId).catch(() => undefined)
  }

  async sendMessageAsyncForWorkspace(
    workspacePath: string,
    sessionId: string,
    content: string,
  ): Promise<void> {
    await this.initialize()
    this.sessionWorkspace.set(sessionId, workspacePath)
    this.emitUserAndStartTurn(sessionId, content, workspacePath)
    void this.promptSession(sessionId, content, workspacePath).catch(() => undefined)
  }

  private emitUserAndStartTurn(sessionId: string, content: string, workspacePath: string): void {
    const runtimeSelection = this.sessionRuntime.get(sessionId)
    const selectedModel = this.parseModelId(runtimeSelection?.currentModelId)
    const selectedAgent = runtimeSelection?.currentModeId
    const userMessageId = `acp_usr_${randomUUID()}`
    const userPartId = `prt_${randomUUID()}`
    this.ingestSynthetic(
      'message.updated',
      {
        info: {
          id: userMessageId,
          sessionID: sessionId,
          role: 'user',
          parts: [{ type: 'text', id: userPartId, text: content }],
          ...(selectedAgent ? { agent: selectedAgent } : {}),
          ...(selectedModel
            ? {
                model: {
                  providerID: selectedModel.providerId,
                  modelID: selectedModel.modelId,
                },
              }
            : {}),
          time: { completed: Date.now() },
        },
      },
      workspacePath,
    )

    const assistantMessageId = `acp_asst_${randomUUID()}`
    this.activeTurns.set(sessionId, {
      assistantMessageId,
      parts: new Map(),
      activeReasoningPartId: undefined,
      activeTextPartId: undefined,
    })
    this.ingestSynthetic(
      'session.status',
      { sessionID: sessionId, status: { type: 'running' } },
      workspacePath,
    )
  }

  private async promptSession(
    sessionId: string,
    content: string,
    workspacePath: string,
  ): Promise<void> {
    const runtimeSelection = this.sessionRuntime.get(sessionId)
    const selectedModel = this.parseModelId(runtimeSelection?.currentModelId)
    const selectedAgent = runtimeSelection?.currentModeId
    const executePrompt = async () => {
      this.activeRequestWorkspace = workspacePath
      return await this.connection.call<{ stopReason?: string; usage?: Record<string, number> }>(
        'session/prompt',
        {
          sessionId,
          prompt: [{ type: 'text', text: content }],
        },
      )
    }

    try {
      const result = await executePrompt()
      this.finalizePromptSuccess(sessionId, selectedModel, selectedAgent, result, workspacePath)
      this.activeRequestWorkspace = null
      return
    } catch (error) {
      this.activeRequestWorkspace = null
      const rpcError = parseRpcError(error)
      if (!/Session not found/i.test(String(rpcError.message))) {
        this.handlePromptError(sessionId, rpcError, workspacePath)
        return
      }
      await this.loadSessionForWorkspace(workspacePath, sessionId)
      try {
        const result = await executePrompt()
        this.finalizePromptSuccess(sessionId, selectedModel, selectedAgent, result, workspacePath)
        this.activeRequestWorkspace = null
      } catch (retryError) {
        this.activeRequestWorkspace = null
        this.handlePromptError(sessionId, parseRpcError(retryError), workspacePath)
      }
    }
  }

  private finalizePromptSuccess(
    sessionId: string,
    selectedModel: { providerId: string; modelId: string } | null,
    selectedAgent: string | undefined,
    result: { stopReason?: string; usage?: Record<string, number> } | undefined,
    workspacePath: string,
  ): void {
    const turn = this.activeTurns.get(sessionId)
    if (!turn) return
    this.finishActiveReasoning(sessionId, turn.assistantMessageId, turn)
    this.ingestSynthetic(
      'message.updated',
      {
        info: {
          id: turn.assistantMessageId,
          sessionID: sessionId,
          role: 'assistant',
          parts: Array.from(turn.parts.values()),
          time: { completed: Date.now() },
          stopReason: result?.stopReason,
          ...(selectedModel
            ? {
                providerID: selectedModel.providerId,
                modelID: selectedModel.modelId,
              }
            : {}),
          ...(selectedAgent ? { mode: selectedAgent, agent: selectedAgent } : {}),
          ...(result?.usage
            ? {
                tokens: {
                  total: result.usage.totalTokens,
                  input: result.usage.inputTokens,
                  output: result.usage.outputTokens,
                  reasoning: result.usage.thoughtTokens ?? 0,
                  cache: {
                    read: result.usage.cachedReadTokens ?? 0,
                    write: result.usage.cachedWriteTokens ?? 0,
                  },
                },
              }
            : {}),
        },
      },
      workspacePath,
    )
    this.ingestSynthetic(
      'session.status',
      { sessionID: sessionId, status: { type: 'idle' } },
      workspacePath,
    )
    this.activeTurns.delete(sessionId)
    void this.syncSessionTitle(sessionId).catch(() => undefined)
  }

  private handlePromptError(sessionId: string, rpcError: RpcError, workspacePath: string): void {
    if (rpcError.code === -32002 || /auth/i.test(rpcError.message)) {
      this.emitAcpEvent(
        'auth_required',
        {
          message: 'Authentication required. Run `opencode auth login` in terminal and retry.',
          sessionId,
        },
        workspacePath,
      )
    }
    const turn = this.activeTurns.get(sessionId)
    if (turn) {
      this.finishActiveText(turn)
      this.finishActiveReasoning(sessionId, turn.assistantMessageId, turn)
    }
    this.ingestSynthetic(
      'session.error',
      { sessionID: sessionId, error: rpcError.message },
      workspacePath,
    )
    this.ingestSynthetic(
      'session.status',
      { sessionID: sessionId, status: { type: 'error' } },
      workspacePath,
    )
    this.activeTurns.delete(sessionId)
  }

  private finishActiveReasoning(
    sessionId: string,
    assistantMessageId: string,
    turn: StreamingTurn,
  ): void {
    const partId = turn.activeReasoningPartId
    if (!partId) return
    const existing = turn.parts.get(partId)
    turn.activeReasoningPartId = undefined
    if (!existing) return
    const rawTime = existing.time
    const time =
      rawTime && typeof rawTime === 'object'
        ? (rawTime as Record<string, number>)
        : { start: Date.now() }
    if (typeof time.end === 'number') return
    const next = {
      ...existing,
      time: {
        ...time,
        end: Date.now(),
      },
    }
    turn.parts.set(partId, next)
    const workspacePath = this.sessionWorkspace.get(sessionId)
    this.ingestSynthetic(
      'message.part.updated',
      {
        part: {
          ...next,
          sessionID: sessionId,
          messageID: assistantMessageId,
        },
      },
      workspacePath,
    )
  }

  private finishActiveText(turn: StreamingTurn): void {
    turn.activeTextPartId = undefined
  }

  async abortSessionForWorkspace(_workspacePath: string, sessionId: string): Promise<void> {
    await this.initialize()
    // ACP defines cancellation as a notification, not a request. Sending an id
    // makes current OpenCode reject it as an unknown request method.
    this.connection.notify('session/cancel', { sessionId })
  }

  async resolvePermissionForWorkspace(
    _workspacePath: string,
    sessionId: string,
    permissionId: string,
    approved: boolean,
  ): Promise<void> {
    const pending = this.pendingPermissions.get(permissionId)
    if (!pending) {
      console.warn(`[acp] resolvePermission ignored: missing pending permission ${permissionId}`)
      return
    }
    if (pending.sessionId !== sessionId) {
      console.warn(
        `[acp] resolvePermission ignored: session mismatch for ${permissionId} (expected ${pending.sessionId}, got ${sessionId})`,
      )
      return
    }
    this.pendingPermissions.delete(permissionId)
    const outcome: PermissionOutcome = {
      outcome: 'selected',
      optionId: this.findOptionId(pending.options, approved),
    }
    pending.resolve(outcome)
    const workspacePath = this.sessionWorkspace.get(sessionId)
    this.ingestSynthetic(
      'permission.replied',
      { sessionID: sessionId, requestID: permissionId },
      workspacePath,
    )
  }

  async setSessionModelForWorkspace(
    _workspacePath: string,
    sessionId: string,
    modelId: string,
  ): Promise<void> {
    await this.initialize()
    const attempts: Array<[string, Record<string, unknown>]> = [
      ['session/set_config_option', { sessionId, configId: 'model', value: modelId }],
      ['session/set_model', { sessionId, modelId }],
      ['session/unstable_set_model', { sessionId, modelId }],
      ['session/unstable_setSessionModel', { sessionId, modelId }],
    ]
    for (const [method, params] of attempts) {
      try {
        const result = await this.connection.call(method, params)
        this.sessionRuntime.set(sessionId, {
          ...(this.sessionRuntime.get(sessionId) ?? {}),
          currentModelId: modelId,
        })
        this.emitAcpEvent(
          'session.set_model.result',
          { sessionId, modelId, result },
          this.sessionWorkspace.get(sessionId),
        )
        return
      } catch (error) {
        const rpcError = parseRpcError(error)
        if (rpcError.code !== -32601) throw rpcError
      }
    }
    throw new Error('Session model switching is not supported by this ACP agent')
  }

  async setSessionModeForWorkspace(
    _workspacePath: string,
    sessionId: string,
    modeId: string,
  ): Promise<void> {
    await this.initialize()
    const attempts: Array<[string, Record<string, unknown>]> = [
      ['session/set_config_option', { sessionId, configId: 'mode', value: modeId }],
      ['session/set_mode', { sessionId, modeId }],
      ['session/setSessionMode', { sessionId, modeId }],
    ]
    for (const [method, params] of attempts) {
      try {
        const result = await this.connection.call(method, params)
        this.sessionRuntime.set(sessionId, {
          ...(this.sessionRuntime.get(sessionId) ?? {}),
          currentModeId: modeId,
        })
        this.emitAcpEvent(
          'session.set_mode.result',
          { sessionId, modeId, result },
          this.sessionWorkspace.get(sessionId),
        )
        return
      } catch (error) {
        const rpcError = parseRpcError(error)
        if (rpcError.code !== -32601) throw rpcError
      }
    }
    throw new Error('Session mode switching is not supported by this ACP agent')
  }

  private emitAcpEvent(type: string, payload: unknown, workspacePath?: string): void {
    if (this.mainWindow.isDestroyed()) return
    this.mainWindow.webContents.send('acp:event', {
      type,
      payload,
      workspacePath,
      timestamp: Date.now(),
    })
  }

  private ingestSynthetic(
    eventType: string,
    properties: Record<string, unknown>,
    workspacePath?: string,
  ): void {
    if (!workspacePath) return
    const bridge = this.resolveBridge(workspacePath)
    if (!bridge) return
    const envelope = {
      payload: {
        type: eventType,
        properties,
      },
    }
    bridge.ingestEnvelope(envelope, JSON.stringify(envelope))
  }

  private handleNotification(method: string, params: unknown): void {
    this.emitAcpEvent(method, params)
    if (method !== 'session/update') return
    const payload = (params ?? {}) as {
      sessionId?: string
      update?: Record<string, unknown>
    }
    const sessionId = payload.sessionId
    const update = payload.update
    if (!sessionId || !update) return
    this.handleSessionUpdate(sessionId, update)
  }

  private handleSessionUpdate(sessionId: string, update: Record<string, unknown>): void {
    const kind = typeof update.sessionUpdate === 'string' ? update.sessionUpdate : undefined
    if (!kind) return

    const turn = this.activeTurns.get(sessionId)
    const assistantMessageId = turn?.assistantMessageId ?? `acp_asst_${randomUUID()}`
    if (!turn) {
      this.activeTurns.set(sessionId, {
        assistantMessageId,
        parts: new Map(),
        activeReasoningPartId: undefined,
        activeTextPartId: undefined,
      })
    }
    const activeTurn = this.activeTurns.get(sessionId)!
    const workspacePath = this.sessionWorkspace.get(sessionId)

    switch (kind) {
      case 'agent_message_chunk': {
        this.finishActiveReasoning(sessionId, assistantMessageId, activeTurn)
        const content = update.content as { type?: string; text?: string } | undefined
        const delta = content?.type === 'text' ? (content.text ?? '') : ''
        if (!delta) return
        const partId = activeTurn.activeTextPartId ?? `acp_text_part_${randomUUID()}`
        activeTurn.activeTextPartId = partId
        const existing = activeTurn.parts.get(partId) ?? { type: 'text', id: partId, text: '' }
        activeTurn.parts.set(partId, {
          ...existing,
          text: `${String(existing.text ?? '')}${delta}`,
        })
        this.ingestSynthetic(
          'message.part.delta',
          {
            sessionID: sessionId,
            messageID: assistantMessageId,
            partID: partId,
            field: 'text',
            delta,
          },
          workspacePath,
        )
        return
      }
      case 'agent_thought_chunk': {
        this.finishActiveText(activeTurn)
        const content = update.content as { type?: string; text?: string } | undefined
        const delta = content?.type === 'text' ? (content.text ?? '') : ''
        if (!delta) return
        const partId = activeTurn.activeReasoningPartId ?? `acp_reasoning_part_${randomUUID()}`
        activeTurn.activeReasoningPartId = partId
        const existing = activeTurn.parts.get(partId) ?? {
          type: 'reasoning',
          id: partId,
          text: '',
          time: { start: Date.now() },
        }
        const next = {
          ...existing,
          text: `${String(existing.text ?? '')}${delta}`,
        }
        activeTurn.parts.set(partId, next)
        this.ingestSynthetic(
          'message.part.updated',
          {
            part: {
              ...next,
              sessionID: sessionId,
              messageID: assistantMessageId,
            },
          },
          workspacePath,
        )
        return
      }
      case 'tool_call': {
        this.finishActiveText(activeTurn)
        this.finishActiveReasoning(sessionId, assistantMessageId, activeTurn)
        const toolCallId = String(update.toolCallId ?? randomUUID())
        const partId = toolCallId
        const previous = activeTurn.parts.get(partId) as
          { state?: { status?: ToolLifecycleState } } | undefined
        const previousStatus = previous?.state?.status
        const part = {
          id: partId,
          callID: toolCallId,
          messageID: assistantMessageId,
          sessionID: sessionId,
          type: 'tool',
          tool: String(update.title ?? update.kind ?? 'tool'),
          state: {
            status: 'pending',
            input: (update.rawInput as Record<string, unknown>) ?? {},
            title: String(update.title ?? update.kind ?? 'tool'),
          },
        }
        if (previousStatus && toolStateRank(previousStatus) > toolStateRank('pending')) {
          break
        }
        const mergedPart = {
          ...(activeTurn.parts.get(partId) as Record<string, unknown> | undefined),
          ...part,
        }
        activeTurn.parts.set(partId, mergedPart)
        this.ingestSynthetic('message.part.updated', { part: mergedPart }, workspacePath)
        return
      }
      case 'tool_call_update': {
        this.finishActiveText(activeTurn)
        this.finishActiveReasoning(sessionId, assistantMessageId, activeTurn)
        const toolCallId = String(update.toolCallId ?? randomUUID())
        const partId = toolCallId
        const status = String(update.status ?? 'running')
        const mappedStatus: ToolLifecycleState =
          status === 'completed'
            ? 'completed'
            : status === 'failed'
              ? 'error'
              : status === 'pending'
                ? 'pending'
                : 'running'

        const previous = (activeTurn.parts.get(partId) as Record<string, unknown> | undefined) ?? {
          id: partId,
          callID: toolCallId,
          messageID: assistantMessageId,
          sessionID: sessionId,
          type: 'tool',
          tool: String(update.title ?? update.kind ?? 'tool'),
        }
        const previousState =
          previous.state && typeof previous.state === 'object'
            ? (previous.state as Record<string, unknown>)
            : undefined
        const previousStatus =
          typeof previousState?.status === 'string'
            ? (previousState.status as ToolLifecycleState)
            : undefined
        if (previousStatus && toolStateRank(previousStatus) > toolStateRank(mappedStatus)) {
          return
        }
        const state = {
          status: mappedStatus,
          input:
            (update.rawInput as Record<string, unknown> | undefined) ??
            (previousState?.input as Record<string, unknown> | undefined) ??
            {},
          output:
            (update.rawOutput as { output?: string } | undefined)?.output ??
            (update.content as Array<{ content?: { text?: string } }> | undefined)?.[0]?.content
              ?.text ??
            (typeof previousState?.output === 'string' ? previousState.output : ''),
          error:
            (update.rawOutput as { error?: string } | undefined)?.error ??
            (typeof previousState?.error === 'string' ? previousState.error : undefined),
          title: String(update.title ?? previous.tool ?? 'tool'),
          metadata:
            (update.rawOutput as { metadata?: unknown } | undefined)?.metadata ??
            previousState?.metadata,
        }
        const nextPart = { ...previous, state }
        activeTurn.parts.set(partId, nextPart)
        this.ingestSynthetic('message.part.updated', { part: nextPart }, workspacePath)
        return
      }
      case 'plan': {
        this.finishActiveText(activeTurn)
        this.finishActiveReasoning(sessionId, assistantMessageId, activeTurn)
        const partId = 'acp_plan_part'
        const next = {
          type: 'subtask',
          id: partId,
          messageID: assistantMessageId,
          sessionID: sessionId,
          entries: update.entries,
        }
        activeTurn.parts.set(partId, next)
        this.ingestSynthetic('message.part.updated', { part: next }, workspacePath)
        return
      }
      case 'usage_update':
      case 'available_commands_update':
      case 'user_message_chunk': {
        this.finishActiveText(activeTurn)
        if (kind === 'user_message_chunk') {
          this.finishActiveReasoning(sessionId, assistantMessageId, activeTurn)
        }
        return
      }
      default: {
        this.finishActiveText(activeTurn)
        this.finishActiveReasoning(sessionId, assistantMessageId, activeTurn)
        const partId = `acp_${kind}_${randomUUID()}`
        const next = {
          type: 'agent',
          id: partId,
          messageID: assistantMessageId,
          sessionID: sessionId,
          sessionUpdate: kind,
          payload: update,
        }
        activeTurn.parts.set(partId, next)
        this.ingestSynthetic('message.part.updated', { part: next }, workspacePath)
      }
    }
  }

  private async handleRequest(method: string, params: unknown): Promise<unknown> {
    this.emitAcpEvent(method, params)
    switch (method) {
      case 'session/request_permission':
      case 'requestPermission': {
        const payload = (params ?? {}) as {
          sessionId?: string
          sessionID?: string
          toolCall?: Record<string, unknown>
          options?: Array<{ optionId?: string; kind?: string }>
        }
        const sessionId = String(payload.sessionId ?? payload.sessionID ?? '')
        const workspacePath =
          this.sessionWorkspace.get(sessionId) ?? this.activeRequestWorkspace ?? undefined
        const toolCall = payload.toolCall ?? {}
        const requestId = String(toolCall.toolCallId ?? randomUUID())
        this.ingestSynthetic(
          'permission.asked',
          {
            sessionID: sessionId,
            requestID: requestId,
            id: requestId,
            permission: String(toolCall.kind ?? toolCall.title ?? 'tool'),
            tool: String(toolCall.title ?? toolCall.kind ?? 'tool'),
            metadata: (toolCall.rawInput as Record<string, unknown>) ?? {},
          },
          workspacePath,
        )
        return await new Promise<PermissionOutcome>((resolve) => {
          this.pendingPermissions.set(requestId, { sessionId, options: payload.options, resolve })
          setTimeout(() => {
            const pending = this.pendingPermissions.get(requestId)
            if (!pending) return
            this.pendingPermissions.delete(requestId)
            pending.resolve({
              outcome: 'selected',
              optionId: this.findOptionId(payload.options, false),
            })
            this.ingestSynthetic(
              'permission.replied',
              {
                sessionID: sessionId,
                requestID: requestId,
              },
              workspacePath,
            )
          }, 60_000)
        })
      }
      case 'fs/read_text_file':
      case 'readTextFile': {
        const payload = (params ?? {}) as { path?: string }
        if (!payload.path) throw new Error('path is required')
        const content = await fs.readFile(payload.path, 'utf8')
        return { content }
      }
      case 'fs/write_text_file':
      case 'writeTextFile': {
        const payload = (params ?? {}) as { path?: string; content?: string }
        if (!payload.path) throw new Error('path is required')
        await fs.writeFile(payload.path, payload.content ?? '', 'utf8')
        return { ok: true }
      }
      case 'terminal/create': {
        const payload = (params ?? {}) as {
          command?: string
          args?: string[]
          cwd?: string
          env?: Array<{ name: string; value: string }>
        }
        const id = `term_${randomUUID()}`
        const env =
          payload.env?.reduce<Record<string, string>>((acc, item) => {
            acc[item.name] = item.value
            return acc
          }, {}) ?? {}
        const proc = spawn(payload.command ?? 'cmd', payload.args ?? [], {
          cwd: payload.cwd ?? this.activeRequestWorkspace ?? process.cwd(),
          env: { ...process.env, ...env },
          shell: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        })
        const state = { process: proc, output: '', exited: false, exitCode: null as number | null }
        proc.stdout?.on('data', (chunk: Buffer) => {
          state.output += chunk.toString()
        })
        proc.stderr?.on('data', (chunk: Buffer) => {
          state.output += chunk.toString()
        })
        proc.on('exit', (code) => {
          state.exited = true
          state.exitCode = code
        })
        this.terminals.set(id, state)
        return { terminalId: id }
      }
      case 'terminal/read_output':
      case 'terminal/get_output': {
        const payload = (params ?? {}) as { terminalId?: string }
        const terminal = payload.terminalId ? this.terminals.get(payload.terminalId) : undefined
        return { output: terminal?.output ?? '' }
      }
      case 'terminal/kill':
      case 'terminal/release': {
        const payload = (params ?? {}) as { terminalId?: string }
        const terminal = payload.terminalId ? this.terminals.get(payload.terminalId) : undefined
        if (terminal) {
          terminal.process.kill()
          this.terminals.delete(payload.terminalId!)
        }
        return { ok: true }
      }
      case 'terminal/wait_for_exit': {
        const payload = (params ?? {}) as { terminalId?: string }
        const terminal = payload.terminalId ? this.terminals.get(payload.terminalId) : undefined
        if (!terminal) return { exitCode: 0 }
        if (terminal.exited) return { exitCode: terminal.exitCode ?? 0 }
        return await new Promise<{ exitCode: number }>((resolve) => {
          terminal.process.once('exit', (code) => resolve({ exitCode: code ?? 0 }))
        })
      }
      default: {
        throw new Error(`Unsupported ACP client method: ${method}`)
      }
    }
  }

  private findOptionId(
    options: Array<{ optionId?: string; kind?: string }> | undefined,
    approved: boolean,
  ): string {
    const preferredKinds = approved
      ? ['allow_once', 'allow_always']
      : ['reject_once', 'reject_always']
    const byKind = options?.find((option) => option.kind && preferredKinds.includes(option.kind))
    if (byKind?.optionId) return byKind.optionId
    return approved ? 'once' : 'reject'
  }

  private updateSessionRuntimeFromPayload(
    sessionId: string,
    models: unknown,
    modes: unknown,
  ): void {
    const currentModelId =
      models &&
      typeof models === 'object' &&
      typeof (models as { currentModelId?: unknown }).currentModelId === 'string'
        ? ((models as { currentModelId: string }).currentModelId as string)
        : undefined
    const currentModeId =
      modes &&
      typeof modes === 'object' &&
      typeof (modes as { currentModeId?: unknown }).currentModeId === 'string'
        ? ((modes as { currentModeId: string }).currentModeId as string)
        : undefined

    if (!currentModelId && !currentModeId) return

    this.sessionRuntime.set(sessionId, {
      ...(this.sessionRuntime.get(sessionId) ?? {}),
      ...(currentModelId ? { currentModelId } : {}),
      ...(currentModeId ? { currentModeId } : {}),
    })
  }

  private normalizeSessionResult<T extends AcpSessionResult>(result: T): T {
    if (!Array.isArray(result.configOptions)) return result

    const findOption = (category: string, fallbackId: string) =>
      result.configOptions?.find(
        (option) => option.category === category || option.id === fallbackId,
      )
    const modelOption = findOption('model', 'model')
    const modeOption = findOption('mode', 'mode')

    const models =
      result.models ??
      (modelOption
        ? {
            currentModelId:
              typeof modelOption.currentValue === 'string' ? modelOption.currentValue : undefined,
            availableModels: (modelOption.options ?? [])
              .filter((option) => typeof option.value === 'string')
              .map((option) => ({
                modelId: option.value as string,
                name: typeof option.name === 'string' ? option.name : (option.value as string),
              })),
          }
        : undefined)
    const modes =
      result.modes ??
      (modeOption
        ? {
            currentModeId:
              typeof modeOption.currentValue === 'string' ? modeOption.currentValue : undefined,
            availableModes: (modeOption.options ?? [])
              .filter((option) => typeof option.value === 'string')
              .map((option) => ({
                id: option.value as string,
                name: typeof option.name === 'string' ? option.name : (option.value as string),
                ...(typeof option.description === 'string'
                  ? { description: option.description }
                  : {}),
              })),
          }
        : undefined)

    return { ...result, ...(models ? { models } : {}), ...(modes ? { modes } : {}) }
  }

  private parseModelId(
    modelId: string | undefined,
  ): { providerId: string; modelId: string } | null {
    if (!modelId) return null
    const parts = modelId.split('/')
    if (parts.length < 2) return null
    return {
      providerId: parts[0],
      modelId: parts[1],
    }
  }

  private async listSessions(
    workspacePath: string,
  ): Promise<Array<{ sessionId: string; title?: string }>> {
    const attempts: Array<[string, Record<string, unknown>]> = [
      ['session/list', { cwd: workspacePath }],
      ['session/unstable_list', { cwd: workspacePath }],
      ['session/unstable_listSessions', { cwd: workspacePath }],
    ]

    for (const [method, params] of attempts) {
      try {
        const result = await this.connection.call<{
          sessions?: Array<{ sessionId?: string; title?: string }>
        }>(method, params)
        const sessions =
          result.sessions
            ?.filter((row) => typeof row.sessionId === 'string' && row.sessionId.length > 0)
            .map((row) => ({ sessionId: row.sessionId!, title: row.title })) ?? []
        if (sessions.length > 0) return sessions
      } catch (error) {
        const rpcError = parseRpcError(error)
        if (rpcError.code !== -32601) throw rpcError
      }
    }
    return []
  }

  private async syncSessionTitle(sessionId: string): Promise<void> {
    const workspacePath = this.sessionWorkspace.get(sessionId)
    if (!workspacePath) return
    const sessions = await this.listSessions(workspacePath)
    const row = sessions.find((session) => session.sessionId === sessionId)
    if (!row?.title) return
    this.ingestSynthetic(
      'session.updated',
      {
        info: {
          id: sessionId,
          title: row.title,
        },
      },
      workspacePath,
    )
  }
}

class ACPWorkspaceClient implements AgentClient {
  constructor(
    private core: ACPClient,
    private workspacePath: string,
  ) {}

  async createSession(title?: string): Promise<AgentSession> {
    return await this.core.createSessionForWorkspace(this.workspacePath, title)
  }

  async loadSession(sessionId: string): Promise<void> {
    await this.core.loadSessionForWorkspace(this.workspacePath, sessionId)
  }

  async deleteSession(id: string): Promise<void> {
    await this.core.deleteSessionForWorkspace(this.workspacePath, id)
  }

  async sendMessageAsync(sessionId: string, content: string): Promise<void> {
    await this.core.sendMessageAsyncForWorkspace(this.workspacePath, sessionId, content)
  }

  async abortSession(sessionId: string): Promise<void> {
    await this.core.abortSessionForWorkspace(this.workspacePath, sessionId)
  }

  async resolvePermission(
    sessionId: string,
    permissionId: string,
    approved: boolean,
  ): Promise<void> {
    await this.core.resolvePermissionForWorkspace(
      this.workspacePath,
      sessionId,
      permissionId,
      approved,
    )
  }

  async setSessionModel(sessionId: string, modelId: string): Promise<void> {
    await this.core.setSessionModelForWorkspace(this.workspacePath, sessionId, modelId)
  }

  async setSessionMode(sessionId: string, modeId: string): Promise<void> {
    await this.core.setSessionModeForWorkspace(this.workspacePath, sessionId, modeId)
  }
}
