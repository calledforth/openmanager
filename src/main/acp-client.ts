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
  resolve: (outcome: PermissionOutcome) => void
}

interface StreamingTurn {
  assistantMessageId: string
  parts: Map<string, Record<string, unknown>>
}

interface SessionRuntimeSelection {
  currentModelId?: string
  currentModeId?: string
}

type RpcError = Error & { code?: number; data?: unknown }

function parseRpcError(error: unknown): RpcError {
  const err = error instanceof Error ? (error as RpcError) : (new Error(String(error)) as RpcError)
  return err
}

export class ACPClient implements AgentClient {
  private initialized = false
  private pendingPermissions = new Map<string, PendingPermission>()
  private activeTurns = new Map<string, StreamingTurn>()
  private sessionRuntime = new Map<string, SessionRuntimeSelection>()
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
    private workspacePath: string,
    private bridge: SSEBridge,
    private mainWindow: BrowserWindow,
  ) {
    this.connection.onNotification((method, params) => this.handleNotification(method, params))
    this.connection.setRequestHandler((method, params) => this.handleRequest(method, params))
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

  async createSession(title?: string): Promise<AgentSession> {
    await this.initialize()
    const result = await this.connection.call<{
      sessionId: string
      models?: unknown
      modes?: unknown
      _meta?: unknown
    }>('session/new', {
      cwd: this.workspacePath,
      mcpServers: [],
      ...(title ? { title } : {}),
    })
    this.emitAcpEvent('session.new.result', result)
    this.updateSessionRuntimeFromPayload(result.sessionId, result.models, result.modes)
    await this.syncSessionTitle(result.sessionId).catch(() => undefined)
    return {
      id: result.sessionId,
      title,
      status: 'idle',
      createdAt: new Date().toISOString(),
    }
  }

  async deleteSession(id: string): Promise<void> {
    await this.initialize()
    // OpenCode ACP currently doesn't expose a delete-session RPC method.
    // Project local deletion through the existing SSEBridge -> Convex path.
    this.sessionRuntime.delete(id)
    this.activeTurns.delete(id)
    this.ingestSynthetic('session.deleted', { info: { id } })
  }

  async loadSession(sessionId: string): Promise<void> {
    await this.initialize()
    const result = await this.connection.call<{
      sessionId?: string
      models?: unknown
      modes?: unknown
      _meta?: unknown
    }>('session/load', {
      sessionId,
      cwd: this.workspacePath,
      mcpServers: [],
    })
    this.emitAcpEvent('session.load.result', { sessionId, ...result })
    this.updateSessionRuntimeFromPayload(sessionId, result.models, result.modes)
    await this.syncSessionTitle(sessionId).catch(() => undefined)
  }

  async sendMessageAsync(sessionId: string, content: string): Promise<void> {
    await this.initialize()
    const runtimeSelection = this.sessionRuntime.get(sessionId)
    const selectedModel = this.parseModelId(runtimeSelection?.currentModelId)
    const selectedAgent = runtimeSelection?.currentModeId

    const userMessageId = `acp_usr_${randomUUID()}`
    const userPartId = `prt_${randomUUID()}`
    this.ingestSynthetic('message.updated', {
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
    })

    const assistantMessageId = `acp_asst_${randomUUID()}`
    this.activeTurns.set(sessionId, { assistantMessageId, parts: new Map() })

    this.ingestSynthetic('session.status', { sessionID: sessionId, status: { type: 'running' } })

    void this.connection
      .call<{ stopReason?: string; usage?: Record<string, number> }>('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: content }],
      })
      .then((result) => {
        const turn = this.activeTurns.get(sessionId)
        if (!turn) return
        this.ingestSynthetic('message.updated', {
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
        })
        this.ingestSynthetic('session.status', { sessionID: sessionId, status: { type: 'idle' } })
        this.activeTurns.delete(sessionId)
        void this.syncSessionTitle(sessionId).catch(() => undefined)
      })
      .catch((error) => {
        const rpcError = parseRpcError(error)
        if (rpcError.code === -32002 || /auth/i.test(rpcError.message)) {
          this.emitAcpEvent('auth_required', {
            message: 'Authentication required. Run `opencode auth login` in terminal and retry.',
            sessionId,
          })
        }
        this.ingestSynthetic('session.error', { sessionID: sessionId, error: rpcError.message })
        this.ingestSynthetic('session.status', { sessionID: sessionId, status: { type: 'error' } })
        this.activeTurns.delete(sessionId)
      })
  }

  async abortSession(sessionId: string): Promise<void> {
    await this.initialize()
    try {
      await this.connection.call('session/cancel', { sessionId })
    } catch (error) {
      const rpcError = parseRpcError(error)
      if (rpcError.code === -32601) {
        await this.connection.call('cancel', { sessionId })
      } else {
        throw rpcError
      }
    }
  }

  async resolvePermission(sessionId: string, permissionId: string, approved: boolean): Promise<void> {
    const pending = this.pendingPermissions.get(permissionId)
    if (!pending || pending.sessionId !== sessionId) return
    this.pendingPermissions.delete(permissionId)
    const outcome: PermissionOutcome = {
      outcome: 'selected',
      optionId: approved ? 'once' : 'reject',
    }
    pending.resolve(outcome)
    this.ingestSynthetic('permission.replied', { sessionID: sessionId, requestID: permissionId })
  }

  async setSessionModel(sessionId: string, modelId: string): Promise<void> {
    await this.initialize()
    const attempts: Array<[string, Record<string, unknown>]> = [
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
        this.emitAcpEvent('session.set_model.result', { sessionId, modelId, result })
        return
      } catch (error) {
        const rpcError = parseRpcError(error)
        if (rpcError.code !== -32601) throw rpcError
      }
    }
    throw new Error('Session model switching is not supported by this ACP agent')
  }

  async setSessionMode(sessionId: string, modeId: string): Promise<void> {
    await this.initialize()
    const attempts: Array<[string, Record<string, unknown>]> = [
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
        this.emitAcpEvent('session.set_mode.result', { sessionId, modeId, result })
        return
      } catch (error) {
        const rpcError = parseRpcError(error)
        if (rpcError.code !== -32601) throw rpcError
      }
    }
    throw new Error('Session mode switching is not supported by this ACP agent')
  }

  private emitAcpEvent(type: string, payload: unknown): void {
    if (this.mainWindow.isDestroyed()) return
    this.mainWindow.webContents.send('acp:event', { type, payload, timestamp: Date.now() })
  }

  private ingestSynthetic(eventType: string, properties: Record<string, unknown>): void {
    const envelope = {
      payload: {
        type: eventType,
        properties,
      },
    }
    this.bridge.ingestEnvelope(envelope, JSON.stringify(envelope))
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
      this.activeTurns.set(sessionId, { assistantMessageId, parts: new Map() })
    }
    const activeTurn = this.activeTurns.get(sessionId)!

    switch (kind) {
      case 'agent_message_chunk': {
        const content = update.content as { type?: string; text?: string } | undefined
        const delta = content?.type === 'text' ? content.text ?? '' : ''
        if (!delta) return
        const partId = 'acp_text_part'
        const existing = activeTurn.parts.get(partId) ?? { type: 'text', id: partId, text: '' }
        activeTurn.parts.set(partId, {
          ...existing,
          text: `${String(existing.text ?? '')}${delta}`,
        })
        this.ingestSynthetic('message.part.delta', {
          sessionID: sessionId,
          messageID: assistantMessageId,
          partID: partId,
          field: 'text',
          delta,
        })
        return
      }
      case 'agent_thought_chunk': {
        const content = update.content as { type?: string; text?: string } | undefined
        const delta = content?.type === 'text' ? content.text ?? '' : ''
        if (!delta) return
        const partId = 'acp_reasoning_part'
        const existing = activeTurn.parts.get(partId) ?? { type: 'reasoning', id: partId, text: '' }
        const next = {
          ...existing,
          text: `${String(existing.text ?? '')}${delta}`,
        }
        activeTurn.parts.set(partId, next)
        this.ingestSynthetic('message.part.updated', {
          part: {
            ...next,
            sessionID: sessionId,
            messageID: assistantMessageId,
          },
        })
        return
      }
      case 'tool_call': {
        const toolCallId = String(update.toolCallId ?? randomUUID())
        const partId = toolCallId
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
        activeTurn.parts.set(partId, part)
        this.ingestSynthetic('message.part.updated', { part })
        return
      }
      case 'tool_call_update': {
        const toolCallId = String(update.toolCallId ?? randomUUID())
        const partId = toolCallId
        const status = String(update.status ?? 'running')
        const mappedStatus =
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
        const state = {
          status: mappedStatus,
          input: (update.rawInput as Record<string, unknown>) ?? {},
          output:
            (update.rawOutput as { output?: string } | undefined)?.output ??
            ((update.content as Array<{ content?: { text?: string } }> | undefined)?.[0]?.content?.text ?? ''),
          error: (update.rawOutput as { error?: string } | undefined)?.error,
          title: String(update.title ?? previous.tool ?? 'tool'),
          metadata: (update.rawOutput as { metadata?: unknown } | undefined)?.metadata,
        }
        const nextPart = { ...previous, state }
        activeTurn.parts.set(partId, nextPart)
        this.ingestSynthetic('message.part.updated', { part: nextPart })
        return
      }
      case 'plan': {
        const partId = 'acp_plan_part'
        const next = {
          type: 'subtask',
          id: partId,
          messageID: assistantMessageId,
          sessionID: sessionId,
          entries: update.entries,
        }
        activeTurn.parts.set(partId, next)
        this.ingestSynthetic('message.part.updated', { part: next })
        return
      }
      case 'usage_update':
      case 'available_commands_update':
      case 'user_message_chunk': {
        return
      }
      default: {
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
        this.ingestSynthetic('message.part.updated', { part: next })
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
          toolCall?: Record<string, unknown>
          options?: Array<{ optionId?: string; kind?: string }>
        }
        const sessionId = String(payload.sessionId ?? '')
        const toolCall = payload.toolCall ?? {}
        const requestId = String(toolCall.toolCallId ?? randomUUID())
        this.ingestSynthetic('permission.asked', {
          sessionID: sessionId,
          requestID: requestId,
          id: requestId,
          permission: String(toolCall.kind ?? toolCall.title ?? 'tool'),
          tool: String(toolCall.title ?? toolCall.kind ?? 'tool'),
          metadata: (toolCall.rawInput as Record<string, unknown>) ?? {},
        })
        return await new Promise<PermissionOutcome>((resolve) => {
          this.pendingPermissions.set(requestId, { sessionId, resolve })
          setTimeout(() => {
            const pending = this.pendingPermissions.get(requestId)
            if (!pending) return
            this.pendingPermissions.delete(requestId)
            pending.resolve({
              outcome: 'selected',
              optionId: this.findOptionId(payload.options, false),
            })
            this.ingestSynthetic('permission.replied', { sessionID: sessionId, requestID: requestId })
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
          cwd: payload.cwd ?? this.workspacePath,
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

  private updateSessionRuntimeFromPayload(sessionId: string, models: unknown, modes: unknown): void {
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

  private parseModelId(modelId: string | undefined): { providerId: string; modelId: string } | null {
    if (!modelId) return null
    const parts = modelId.split('/')
    if (parts.length < 2) return null
    return {
      providerId: parts[0],
      modelId: parts[1],
    }
  }

  private async listSessions(): Promise<Array<{ sessionId: string; title?: string }>> {
    const attempts: Array<[string, Record<string, unknown>]> = [
      ['session/list', { cwd: this.workspacePath }],
      ['session/unstable_list', { cwd: this.workspacePath }],
      ['session/unstable_listSessions', { cwd: this.workspacePath }],
    ]

    for (const [method, params] of attempts) {
      try {
        const result = await this.connection.call<{ sessions?: Array<{ sessionId?: string; title?: string }> }>(
          method,
          params,
        )
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
    const sessions = await this.listSessions()
    const row = sessions.find((session) => session.sessionId === sessionId)
    if (!row?.title) return
    this.ingestSynthetic('session.updated', {
      info: {
        id: sessionId,
        title: row.title,
      },
    })
  }
}
