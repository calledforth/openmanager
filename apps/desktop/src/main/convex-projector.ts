import type {
  AgentEvent,
  ContentBlock,
  PermissionRequest,
  TokenUsage,
  ToolCall,
  ToolCallContent,
  ToolCallUpdate,
} from '@agentpack/contract'
import { api } from '@openmanager/convex/_generated/api'
import { ConvexClient } from 'convex/browser'
import {
  estimateConvexPayloadBytes,
  extractConvexTelemetryContext,
  recordConvexTelemetry,
} from './convex-telemetry'

type PartData = { type: string; id: string; [key: string]: unknown }

type RuntimeMetadata = {
  providerId?: string
  modelId?: string
  modeId?: string
  finishReason?: string
  tokens?: {
    input?: number
    output?: number
    reasoning?: number
    cacheRead?: number
    cacheWrite?: number
    total?: number
  }
}

type MessageBuffer = {
  content: string
  sessionExternalId: string
  role: string
  parts: Map<string, PartData>
  placeholderInserted: boolean
  chunkIndex: number
  flushedLength: number
  runtimeMetadata: RuntimeMetadata
}

type ActiveTurn = {
  sessionId: string
  userMessageId: string
  assistantMessageId: string
  textPartId?: string
  reasoningPartId?: string
}

const FINALIZE_ATTEMPTS = 3
const FINALIZE_RETRY_BASE_MS = 500

function statusForTool(status: ToolCall['status']): string {
  if (status === 'in_progress') return 'running'
  if (status === 'failed') return 'error'
  return status ?? 'pending'
}

function toolStatusRank(status: unknown): number {
  if (status === 'completed' || status === 'error') return 2
  if (status === 'running') return 1
  return 0
}

function titleFromPrompt(prompt: string): string | undefined {
  const singleLine = prompt.replace(/\s+/g, ' ').trim()
  if (!singleLine) return undefined
  return singleLine.length > 80 ? `${singleLine.slice(0, 77)}...` : singleLine
}

export class ConvexProjector {
  private readonly buffers = new Map<string, MessageBuffer>()
  private readonly turns = new Map<string, ActiveTurn>()
  private readonly sessionByThread = new Map<string, string>()
  private readonly queues = new Map<string, Promise<void>>()

  constructor(
    private readonly convex: ConvexClient,
    private readonly clientId: string,
  ) {}

  consume(event: AgentEvent): void {
    this.enqueue(event.threadId, () => this.project(event))
  }

  waitForThread(threadId: string): Promise<void> {
    return this.queues.get(threadId) ?? Promise.resolve()
  }

  updateSessionTitle(threadId: string, workspacePath: string | undefined, title: string): void {
    this.enqueue(threadId, async () => {
      const sessionId = this.sessionByThread.get(threadId)
      if (!sessionId || !workspacePath) return
      await this.runMutation('sessions.upsertTitle', (api as any).sessions.upsertTitle, {
        workspacePath,
        externalId: sessionId,
        title,
        clientId: this.clientId,
      })
    })
  }

  resolvePermission(threadId: string, requestId: string): void {
    this.enqueue(threadId, () =>
      this.runMutation('permissions.resolve', (api as any).permissions.resolve, { requestId }),
    )
  }

  private enqueue(threadId: string, operation: () => Promise<void>): void {
    const previous = this.queues.get(threadId) ?? Promise.resolve()
    const next = previous
      .catch(() => undefined)
      .then(operation)
      .catch((error) => {
        console.warn('[convex-projector] projection failed:', (error as Error).message)
      })
    const tracked = next.finally(() => {
      if (this.queues.get(threadId) === tracked) this.queues.delete(threadId)
    })
    this.queues.set(threadId, tracked)
  }

  private async project(event: AgentEvent): Promise<void> {
    const workspacePath = event.workspaceId
    if (event.sessionId) this.sessionByThread.set(event.threadId, event.sessionId)

    switch (event.event) {
      case 'session_created':
      case 'session_loaded':
        if (workspacePath) await this.upsertSession(workspacePath, event.sessionId, 'idle')
        return
      case 'session_deleted':
        await this.runMutation('sessions.remove', api.sessions.remove, {
          externalId: event.sessionId,
        })
        this.sessionByThread.delete(event.threadId)
        return
      case 'prompt_started':
        await this.startTurn(event, workspacePath)
        return
      case 'prompt_completed':
        await this.completeTurn(event, workspacePath)
        return
      case 'user_message_chunk':
        await this.appendUserChunk(event)
        return
      case 'agent_message_chunk':
        await this.appendAgentChunk(event, false)
        return
      case 'agent_thought_chunk':
        await this.appendAgentChunk(event, true)
        return
      case 'tool_call':
        await this.updateTool(event, event.data)
        return
      case 'tool_call_update':
        await this.updateTool(event, event.data)
        return
      case 'tool_call_content':
        await this.appendToolContent(event, event.data.toolCallId, event.data.item)
        return
      case 'permission_request':
        await this.upsertPermission(event.data)
        return
      case 'current_model_update':
        this.updateRuntime(event.sessionId, { modelId: event.data.currentModelId })
        return
      case 'current_mode_update':
        this.updateRuntime(event.sessionId, { modeId: event.data.currentModeId })
        return
      case 'session_info_update':
        if (workspacePath && event.data.title) {
          await this.runMutation('sessions.upsertTitle', (api as any).sessions.upsertTitle, {
            workspacePath,
            externalId: event.sessionId,
            title: event.data.title,
            clientId: this.clientId,
          })
        }
        return
      case 'rpc_error':
      case 'runtime_error':
      case 'auth_required':
        if (event.sessionId && workspacePath) {
          await this.upsertSession(workspacePath, event.sessionId, 'error')
          await this.finalizeTurn(event.threadId)
        }
        return
      case 'process_exited':
        await this.finalizeTurn(event.threadId)
        return
      default:
        return
    }
  }

  private async startTurn(
    event: Extract<AgentEvent, { event: 'prompt_started' }>,
    workspacePath?: string,
  ): Promise<void> {
    const userMessageId = `agent_usr_${event.id}`
    const assistantMessageId = event.messageId ?? `agent_asst_${event.id}`
    const userPart: PartData = {
      type: 'text',
      id: `${userMessageId}_text`,
      text: event.data.prompt,
    }
    this.turns.set(event.threadId, {
      sessionId: event.sessionId,
      userMessageId,
      assistantMessageId,
    })
    if (workspacePath) await this.upsertSession(workspacePath, event.sessionId, 'running')
    await this.runMutation('messages.upsertFinalized', api.messages.upsertFinalized, {
      sessionExternalId: event.sessionId,
      externalId: userMessageId,
      content: event.data.prompt,
      role: 'user',
      parts: [userPart],
      runtimeMetadata: { providerId: event.providerId },
    })
    const title = titleFromPrompt(event.data.prompt)
    if (title && workspacePath) {
      await this.runMutation('sessions.upsertTitle', (api as any).sessions.upsertTitle, {
        workspacePath,
        externalId: event.sessionId,
        title,
        clientId: this.clientId,
      })
    }
  }

  private async completeTurn(
    event: Extract<AgentEvent, { event: 'prompt_completed' }>,
    workspacePath?: string,
  ): Promise<void> {
    const turn = this.turns.get(event.threadId)
    if (turn) {
      const buffer = this.buffers.get(turn.assistantMessageId)
      if (buffer) {
        buffer.runtimeMetadata = {
          ...buffer.runtimeMetadata,
          providerId: event.providerId,
          finishReason: event.data.stopReason,
          tokens: this.tokens(event.data.usage),
        }
      }
      await this.finalizeTurn(event.threadId)
    }
    if (workspacePath) await this.upsertSession(workspacePath, event.sessionId, 'idle')
  }

  private async appendUserChunk(
    event: Extract<AgentEvent, { event: 'user_message_chunk' }>,
  ): Promise<void> {
    const turn = this.turns.get(event.threadId)
    const messageId = event.data.messageId ?? turn?.userMessageId ?? `agent_usr_${event.id}`
    const buffer = this.buffer(messageId, event.sessionId, 'user', event.providerId)
    this.appendContent(buffer, `${messageId}_text`, event.data.content)
    await this.runMutation('messages.upsertFinalized', api.messages.upsertFinalized, {
      sessionExternalId: event.sessionId,
      externalId: messageId,
      content: buffer.content,
      role: 'user',
      parts: [...buffer.parts.values()],
      runtimeMetadata: buffer.runtimeMetadata,
    })
  }

  private async appendAgentChunk(
    event: Extract<AgentEvent, { event: 'agent_message_chunk' | 'agent_thought_chunk' }>,
    reasoning: boolean,
  ): Promise<void> {
    const turn = this.ensureTurn(event)
    const buffer = this.buffer(
      turn.assistantMessageId,
      event.sessionId,
      'assistant',
      event.providerId,
    )
    await this.ensurePlaceholder(turn.assistantMessageId, buffer)
    const partId = reasoning
      ? (turn.reasoningPartId ??= `${turn.assistantMessageId}_reasoning`)
      : (turn.textPartId ??= `${turn.assistantMessageId}_text`)
    const part = this.appendContent(buffer, partId, event.data.content, reasoning)
    const text = event.data.content.type === 'text' ? event.data.content.text : ''
    await this.appendChunk(turn.assistantMessageId, buffer, text, {
      kind: 'part.updated',
      part,
    })
  }

  private async updateTool(
    event: Extract<AgentEvent, { event: 'tool_call' | 'tool_call_update' }>,
    tool: ToolCall | ToolCallUpdate,
  ): Promise<void> {
    const turn = this.ensureTurn(event)
    const buffer = this.buffer(
      turn.assistantMessageId,
      event.sessionId,
      'assistant',
      event.providerId,
    )
    await this.ensurePlaceholder(turn.assistantMessageId, buffer)
    const existing = buffer.parts.get(tool.toolCallId)
    const existingState = (existing?.state as Record<string, unknown> | undefined) ?? {}
    const proposedStatus = statusForTool(tool.status)
    const status =
      toolStatusRank(existingState.status) > toolStatusRank(proposedStatus)
        ? existingState.status
        : proposedStatus
    const part: PartData = {
      ...(existing ?? {}),
      type: 'tool',
      id: tool.toolCallId,
      callID: tool.toolCallId,
      tool: tool.title ?? existing?.tool ?? 'tool',
      state: {
        ...existingState,
        status,
        ...(tool.rawInput !== undefined ? { input: tool.rawInput } : {}),
        ...(tool.rawOutput !== undefined ? { output: tool.rawOutput } : {}),
      },
      ...(tool.kind ? { kind: tool.kind } : {}),
      ...(tool.locations ? { locations: tool.locations } : {}),
      ...(tool.metadata ? { metadata: tool.metadata } : {}),
      ...(tool.content ? { content: tool.content } : {}),
    }
    buffer.parts.set(part.id, part)
    await this.appendChunk(turn.assistantMessageId, buffer, '', {
      kind: 'part.updated',
      part,
    })
  }

  private async appendToolContent(
    event: Extract<AgentEvent, { event: 'tool_call_content' }>,
    toolCallId: string,
    item: ToolCallContent,
  ): Promise<void> {
    const turn = this.ensureTurn(event)
    const buffer = this.buffer(
      turn.assistantMessageId,
      event.sessionId,
      'assistant',
      event.providerId,
    )
    await this.ensurePlaceholder(turn.assistantMessageId, buffer)
    const existing = buffer.parts.get(toolCallId) ?? {
      type: 'tool',
      id: toolCallId,
      callID: toolCallId,
      tool: 'tool',
      state: { status: 'running' },
    }
    const content = Array.isArray(existing.content) ? existing.content : []
    const part = { ...existing, content: [...content, item] }
    buffer.parts.set(toolCallId, part)
    await this.appendChunk(turn.assistantMessageId, buffer, '', {
      kind: 'part.updated',
      part,
    })
  }

  private async upsertPermission(permission: PermissionRequest): Promise<void> {
    const metadata = permission.metadata
    const targetPath =
      typeof metadata?.filepath === 'string'
        ? metadata.filepath
        : typeof metadata?.parentDir === 'string'
          ? metadata.parentDir
          : undefined
    const toolName = permission.toolCall.title || permission.toolCall.kind || 'unknown'
    await this.runMutation('permissions.upsertPending', (api as any).permissions.upsertPending, {
      sessionExternalId: permission.sessionId,
      requestId: permission.requestId,
      permission: permission.toolCall.kind,
      toolName,
      description:
        (typeof metadata?.title === 'string' && metadata.title) ||
        (targetPath
          ? `${toolName} access requested for ${targetPath}`
          : `${toolName} requires permission`),
      input: permission.toolCall.rawInput ?? metadata,
      patterns: metadata?.patterns,
      alwaysPatterns: metadata?.always,
    })
  }

  private ensureTurn(event: AgentEvent & { sessionId: string }): ActiveTurn {
    let turn = this.turns.get(event.threadId)
    if (!turn) {
      turn = {
        sessionId: event.sessionId,
        userMessageId: `agent_usr_${event.id}`,
        assistantMessageId: `agent_asst_${event.id}`,
      }
      this.turns.set(event.threadId, turn)
    }
    return turn
  }

  private buffer(
    messageId: string,
    sessionExternalId: string,
    role: string,
    providerId: string,
  ): MessageBuffer {
    let buffer = this.buffers.get(messageId)
    if (!buffer) {
      buffer = {
        content: '',
        sessionExternalId,
        role,
        parts: new Map(),
        placeholderInserted: false,
        chunkIndex: 0,
        flushedLength: 0,
        runtimeMetadata: { providerId },
      }
      this.buffers.set(messageId, buffer)
    }
    return buffer
  }

  private appendContent(
    buffer: MessageBuffer,
    partId: string,
    content: ContentBlock,
    reasoning = false,
  ): PartData {
    const existing = buffer.parts.get(partId)
    let part: PartData
    if (content.type === 'text') {
      part = {
        ...(existing ?? {}),
        type: reasoning ? 'reasoning' : 'text',
        id: partId,
        text: `${String(existing?.text ?? '')}${content.text}`,
        ...(reasoning ? { time: existing?.time ?? { start: Date.now() } } : {}),
      }
    } else {
      part = { ...content, id: partId }
    }
    buffer.parts.set(partId, part)
    buffer.content = [...buffer.parts.values()]
      .filter((item) => item.type === 'text' && typeof item.text === 'string')
      .map((item) => item.text as string)
      .join('')
    return part
  }

  private async ensurePlaceholder(messageId: string, buffer: MessageBuffer): Promise<void> {
    if (buffer.placeholderInserted) return
    const inserted = await this.runMutation(
      'messages.insertPlaceholder',
      api.messages.insertPlaceholder,
      {
        sessionExternalId: buffer.sessionExternalId,
        externalId: messageId,
        role: buffer.role,
      },
    )
    buffer.placeholderInserted = Boolean(inserted)
  }

  private sentenceBoundary(content: string, flushedLength: number): number {
    const pending = content.slice(flushedLength)
    let length = 0
    for (let index = 0; index < pending.length; index += 1) {
      const char = pending[index]
      const next = pending[index + 1]
      if (
        (char === '\n' || char === '.' || char === '!' || char === '?') &&
        (!next || /\s/.test(next))
      ) {
        length = index + 1
      }
    }
    return length
  }

  private async appendChunk(
    messageId: string,
    buffer: MessageBuffer,
    immediateText: string,
    partUpdate?: { kind: 'part.updated'; part: PartData },
  ): Promise<void> {
    const boundary = this.sentenceBoundary(buffer.content, buffer.flushedLength)
    const chunkText = boundary
      ? buffer.content.slice(buffer.flushedLength, buffer.flushedLength + boundary)
      : immediateText && buffer.content.length === 0
        ? immediateText
        : ''
    if (!chunkText && !partUpdate) return
    buffer.chunkIndex += 1
    if (boundary) buffer.flushedLength += boundary
    await this.runMutation('streamChunks.appendChunk', api.streamChunks.appendChunk, {
      messageExternalId: messageId,
      sessionExternalId: buffer.sessionExternalId,
      chunkIndex: buffer.chunkIndex,
      chunkText,
      partUpdate,
    })
  }

  private async finalizeTurn(threadId: string): Promise<void> {
    const turn = this.turns.get(threadId)
    if (!turn) return
    const buffer = this.buffers.get(turn.assistantMessageId)
    if (buffer) await this.finalize(turn.assistantMessageId, buffer)
    this.turns.delete(threadId)
  }

  private async finalize(messageId: string, buffer: MessageBuffer): Promise<void> {
    const remaining = buffer.content.slice(buffer.flushedLength)
    if (remaining) {
      buffer.chunkIndex += 1
      await this.runMutation('streamChunks.appendChunk', api.streamChunks.appendChunk, {
        messageExternalId: messageId,
        sessionExternalId: buffer.sessionExternalId,
        chunkIndex: buffer.chunkIndex,
        chunkText: remaining,
      })
      buffer.flushedLength = buffer.content.length
    }
    let finalized = false
    for (let attempt = 1; attempt <= FINALIZE_ATTEMPTS; attempt += 1) {
      try {
        await this.runMutation('messages.finalize', api.messages.finalize, {
          sessionExternalId: buffer.sessionExternalId,
          externalId: messageId,
          content: buffer.content,
          role: buffer.role,
          parts: [...buffer.parts.values()],
          runtimeMetadata: buffer.runtimeMetadata,
        })
        finalized = true
        break
      } catch (error) {
        if (attempt === FINALIZE_ATTEMPTS) throw error
        await new Promise((resolve) => setTimeout(resolve, attempt * FINALIZE_RETRY_BASE_MS))
      }
    }
    if (!finalized) return
    await this.runMutation('streamChunks.remove', api.streamChunks.remove, {
      messageExternalId: messageId,
    })
    this.buffers.delete(messageId)
  }

  private updateRuntime(sessionId: string, patch: Partial<RuntimeMetadata>): void {
    for (const buffer of this.buffers.values()) {
      if (buffer.sessionExternalId === sessionId) {
        buffer.runtimeMetadata = { ...buffer.runtimeMetadata, ...patch }
      }
    }
  }

  private tokens(usage?: TokenUsage): RuntimeMetadata['tokens'] {
    if (!usage) return undefined
    return {
      input: usage.inputTokens,
      output: usage.outputTokens,
      reasoning: usage.thoughtTokens,
      cacheRead: usage.cachedReadTokens,
      cacheWrite: usage.cachedWriteTokens,
      total: usage.totalTokens,
    }
  }

  private upsertSession(workspacePath: string, sessionId: string, status: string): Promise<void> {
    return this.runMutation('sessions.upsertStatus', api.sessions.upsertStatus, {
      workspacePath,
      externalId: sessionId,
      status,
      clientId: this.clientId,
    })
  }

  private async runMutation(
    name: string,
    mutationRef: any,
    args: Record<string, unknown>,
  ): Promise<any> {
    const startedAt = Date.now()
    const context = extractConvexTelemetryContext(args)
    recordConvexTelemetry({
      source: 'main',
      kind: 'mutation',
      phase: 'start',
      name,
      requestBytes: estimateConvexPayloadBytes(args),
      ...context,
    })
    try {
      const result = await this.convex.mutation(mutationRef, args)
      recordConvexTelemetry({
        source: 'main',
        kind: 'mutation',
        phase: 'success',
        name,
        durationMs: Date.now() - startedAt,
        requestBytes: estimateConvexPayloadBytes(args),
        responseBytes: estimateConvexPayloadBytes(result),
        ...context,
      })
      return result
    } catch (error) {
      recordConvexTelemetry({
        source: 'main',
        kind: 'mutation',
        phase: 'error',
        name,
        durationMs: Date.now() - startedAt,
        requestBytes: estimateConvexPayloadBytes(args),
        details: error instanceof Error ? error.message : 'Mutation failed',
        ...context,
      })
      throw error
    }
  }
}
