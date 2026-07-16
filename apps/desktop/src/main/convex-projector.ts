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
  pendingPartUpdates: Map<string, number>
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
const PART_UPDATE_CHUNK_INTERVAL = 8

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
  private readonly providerByThread = new Map<string, AgentEvent['providerId']>()
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
      const providerId = this.providerByThread.get(threadId)
      await this.runMutation('sessions.upsertTitle', (api as any).sessions.upsertTitle, {
        workspacePath,
        externalId: sessionId,
        title,
        ...(providerId ? { providerId } : {}),
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
    this.providerByThread.set(event.threadId, event.providerId)
    if (event.sessionId) this.sessionByThread.set(event.threadId, event.sessionId)

    switch (event.event) {
      case 'session_created':
      case 'session_loaded':
        if (workspacePath)
          await this.upsertSession(workspacePath, event.sessionId, 'idle', event.providerId)
        return
      case 'session_deleted':
        await this.runMutation('sessions.remove', api.sessions.remove, {
          externalId: event.sessionId,
        })
        this.sessionByThread.delete(event.threadId)
        this.providerByThread.delete(event.threadId)
        return
      case 'prompt_started':
        await this.startTurn(event, workspacePath)
        return
      case 'prompt_completed':
        await this.completeTurn(event, workspacePath)
        return
      case 'user_message_chunk':
        // The host has already persisted the canonical prompt in prompt_started.
        // ACP user chunks are provider echoes, matching the behavior retained
        // by the pre-AgentPack implementation.
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
            providerId: event.providerId,
            clientId: this.clientId,
          })
        }
        return
      case 'rpc_error':
      case 'runtime_error':
      case 'auth_required':
        if (event.sessionId && workspacePath) {
          await this.upsertSession(workspacePath, event.sessionId, 'error', event.providerId)
          await this.finalizeTurn(event.threadId, 'error')
        }
        return
      case 'process_exited':
        await this.finalizeTurn(event.threadId, 'error')
        return
      default:
        return
    }
  }

  private async startTurn(
    event: Extract<AgentEvent, { event: 'prompt_started' }>,
    workspacePath?: string,
  ): Promise<void> {
    const userMessageId = event.data.userMessageId
    const assistantMessageId = event.messageId ?? `agent_asst_${event.id}`
    const attachments = event.data.attachments ?? []
    const userParts: PartData[] = [
      ...(event.data.prompt
        ? [
            {
              type: 'text',
              id: `${userMessageId}_text`,
              text: event.data.prompt,
            },
          ]
        : []),
      ...attachments.map((attachment, index) => ({
        type: 'image',
        id: `${userMessageId}_image_${index}`,
        attachmentId: attachment.id,
        name: attachment.name,
        mimeType: attachment.mimeType,
        size: attachment.size,
      })),
    ]
    this.turns.set(event.threadId, {
      sessionId: event.sessionId,
      userMessageId,
      assistantMessageId,
    })
    if (workspacePath)
      await this.upsertSession(workspacePath, event.sessionId, 'running', event.providerId)
    await this.runMutation('messages.upsertFinalized', api.messages.upsertFinalized, {
      sessionExternalId: event.sessionId,
      externalId: userMessageId,
      content: event.data.prompt,
      role: 'user',
      parts: userParts,
      runtimeMetadata: { providerId: event.providerId },
    })
    if (attachments.length) {
      await this.runMutation(
        'attachments.assignToMessage',
        (api as any).attachments.assignToMessage,
        {
          ids: attachments.map((attachment) => attachment.id),
          clientId: this.clientId,
          messageExternalId: userMessageId,
        },
      )
    }
    const title = titleFromPrompt(event.data.prompt) ?? attachments[0]?.name
    if (title && workspacePath) {
      await this.runMutation('sessions.upsertTitle', (api as any).sessions.upsertTitle, {
        workspacePath,
        externalId: event.sessionId,
        title,
        providerId: event.providerId,
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
      await this.finalizeTurn(event.threadId, event.data.stopReason)
    }
    if (workspacePath)
      await this.upsertSession(workspacePath, event.sessionId, 'idle', event.providerId)
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
    if (reasoning) {
      turn.textPartId = undefined
    } else {
      this.finishReasoning(turn, buffer)
    }
    const partId = reasoning
      ? (turn.reasoningPartId ??= `${turn.assistantMessageId}_reasoning_${buffer.parts.size}`)
      : (turn.textPartId ??= `${turn.assistantMessageId}_text_${buffer.parts.size}`)
    const part = this.appendContent(buffer, partId, event.data.content, reasoning)
    const text = !reasoning && event.data.content.type === 'text' ? event.data.content.text : ''
    await this.appendChunk(turn.assistantMessageId, buffer, text, {
      partUpdate: { kind: 'part.updated', part },
      coalescePartUpdate: true,
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
    this.finishActiveParts(turn, buffer)
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
      partUpdate: { kind: 'part.updated', part },
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
    this.finishActiveParts(turn, buffer)
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
      partUpdate: { kind: 'part.updated', part },
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
      toolCallId: permission.toolCall.toolCallId || undefined,
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
        chunkIndex: -1,
        flushedLength: 0,
        runtimeMetadata: { providerId },
        pendingPartUpdates: new Map(),
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
    options: {
      partUpdate?: { kind: 'part.updated'; part: PartData }
      coalescePartUpdate?: boolean
    } = {},
  ): Promise<void> {
    const boundary = this.sentenceBoundary(buffer.content, buffer.flushedLength)
    const chunkText = boundary
      ? buffer.content.slice(buffer.flushedLength, buffer.flushedLength + boundary)
      : immediateText && buffer.content.length === 0
        ? immediateText
        : ''
    let partUpdate = options.partUpdate
    if (partUpdate && options.coalescePartUpdate) {
      const previousCount = buffer.pendingPartUpdates.get(partUpdate.part.id)
      const pendingCount = (previousCount ?? -1) + 1
      if (previousCount !== undefined && !boundary && pendingCount < PART_UPDATE_CHUNK_INTERVAL) {
        buffer.pendingPartUpdates.set(partUpdate.part.id, pendingCount)
        partUpdate = undefined
      } else {
        buffer.pendingPartUpdates.set(partUpdate.part.id, 0)
      }
    }
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

  private async finalizeTurn(threadId: string, stopReason?: string): Promise<void> {
    const turn = this.turns.get(threadId)
    if (!turn) return
    const buffer = this.buffers.get(turn.assistantMessageId)
    if (buffer) {
      this.finishActiveParts(turn, buffer)
      this.finishRunningTools(buffer, stopReason)
      await this.finalize(turn.assistantMessageId, buffer)
    }
    this.turns.delete(threadId)
  }

  private finishReasoning(turn: ActiveTurn, buffer: MessageBuffer): void {
    const partId = turn.reasoningPartId
    turn.reasoningPartId = undefined
    if (!partId) return
    const part = buffer.parts.get(partId)
    if (!part) return
    const time =
      part.time && typeof part.time === 'object'
        ? (part.time as Record<string, number>)
        : { start: Date.now() }
    buffer.parts.set(partId, { ...part, time: { ...time, end: time.end ?? Date.now() } })
  }

  private finishActiveParts(turn: ActiveTurn, buffer: MessageBuffer): void {
    turn.textPartId = undefined
    this.finishReasoning(turn, buffer)
  }

  private finishRunningTools(buffer: MessageBuffer, stopReason?: string): void {
    const failed = !!stopReason && /error|fail|cancel|abort/i.test(stopReason)
    for (const [id, part] of buffer.parts) {
      if (part.type !== 'tool') continue
      const state = (part.state as Record<string, unknown> | undefined) ?? {}
      if (toolStatusRank(state.status) >= 2) continue
      buffer.parts.set(id, {
        ...part,
        state: { ...state, status: failed ? 'error' : 'completed' },
      })
    }
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

  private upsertSession(
    workspacePath: string,
    sessionId: string,
    status: string,
    providerId: AgentEvent['providerId'],
  ): Promise<void> {
    return this.runMutation('sessions.upsertStatus', api.sessions.upsertStatus, {
      workspacePath,
      externalId: sessionId,
      status,
      providerId,
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
