import type {
  AgentEvent,
  ContentBlock,
  PlanReviewOutcome,
  ModeListing,
  ModelListing,
  PermissionRequest,
  ProviderId,
  ProviderSessionInfo,
  SubtaskUpdate,
  TokenUsage,
  ToolCall,
  ToolCallContent,
  ToolCallUpdate,
} from '@agentpack/contract'
import { isRecoverableError } from '@agentpack/contract'
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
  startedAt?: number
  completedAt?: number
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
  startedAt: number
  textPartId?: string
  reasoningPartId?: string
}

const FINALIZE_ATTEMPTS = 3
const FINALIZE_RETRY_BASE_MS = 500
const PART_UPDATE_CHUNK_INTERVAL = 8

function timestampMs(timestamp: string): number {
  const parsed = Date.parse(timestamp)
  return Number.isFinite(parsed) ? parsed : Date.now()
}

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

function isTerminalSubtaskStatus(status: unknown): boolean {
  return (
    status === 'completed' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'interrupted' ||
    status === 'unknown'
  )
}

function subtaskStatusFromTurnResult(
  stopReason?: string,
): Pick<SubtaskUpdate, 'status' | 'statusSource' | 'statusReason'> {
  const reason = stopReason?.trim() || 'missing_provider_terminal_status'
  if (/cancel|abort/i.test(reason)) {
    return { status: 'cancelled', statusSource: 'turn_result', statusReason: reason }
  }
  if (/interrupt/i.test(reason)) {
    return { status: 'interrupted', statusSource: 'turn_result', statusReason: reason }
  }
  if (/error|fail/i.test(reason)) {
    return { status: 'failed', statusSource: 'turn_result', statusReason: reason }
  }
  return { status: 'unknown', statusSource: 'turn_result', statusReason: reason }
}

/** Reasoning text extraction, matching `StreamingMessagesStore.text` exactly:
 * live rendering and persistence must not disagree about what a block says. */
function textFromBlock(block: ContentBlock | undefined): string {
  if (!block) return ''
  if (block.type === 'text') return block.text
  if (block.type === 'resource_link') return block.uri
  if (block.type === 'resource') return block.text ?? block.uri ?? ''
  return ''
}

function planResolutionFor(outcome: PlanReviewOutcome): { status: string; reason?: string } {
  if (outcome.outcome === 'accepted') return { status: 'accepted' }
  if (outcome.outcome === 'rejected') {
    const reason = outcome.reason?.trim()
    return { status: 'rejected', ...(reason ? { reason } : {}) }
  }
  return { status: 'cancelled' }
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
  private readonly sentProfileByProvider = new Map<string, string>()

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
        source: 'provider',
        ...(providerId ? { providerId } : {}),
      })
    })
  }

  async syncProviderSessionTitles(
    workspacePath: string,
    providerId: ProviderId,
    sessions: ProviderSessionInfo[],
  ): Promise<void> {
    const titledSessions = sessions.flatMap((session) => {
      const title = session.title?.trim()
      return title ? [{ externalId: session.sessionId, title }] : []
    })
    if (titledSessions.length === 0) return
    await this.runMutation('sessions.syncProviderTitles', api.sessions.syncProviderTitles, {
      workspacePath,
      providerId,
      sessions: titledSessions,
    })
  }

  resolvePermission(threadId: string, requestId: string): void {
    this.enqueue(threadId, () =>
      this.runMutation('permissions.resolve', api.permissions.resolve, { requestId }),
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
      case 'initialized':
        if (event.data.agentInfo) {
          await this.upsertProviderProfile(event.providerId, { agentInfo: event.data.agentInfo })
        }
        return
      case 'session_created':
      case 'session_loaded':
        if (workspacePath)
          await this.upsertSession(workspacePath, event.sessionId, 'idle', event.providerId)
        // Any permission/question that was pending before this (re)start died with its broker.
        await this.runMutation('permissions.clearForSession', api.permissions.clearForSession, {
          sessionExternalId: event.sessionId,
        })
        await this.runMutation('questions.clearForSession', api.questions.clearForSession, {
          sessionExternalId: event.sessionId,
        })
        await this.runMutation('plans.clearForSession', api.plans.clearForSession, {
          sessionExternalId: event.sessionId,
        })
        await this.upsertProviderProfile(event.providerId, {
          models: event.data.models,
          modes: event.data.modes,
          // Only a freshly created session reflects the provider's defaults;
          // a loaded session reports whatever the agent was last using.
          includeDefaults: event.event === 'session_created',
        })
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
      case 'permission_resolved':
        await this.runMutation('permissions.resolve', api.permissions.resolve, {
          requestId: event.data.requestId,
        })
        return
      case 'question_request':
        await this.runMutation('questions.upsertPending', api.questions.upsertPending, {
          sessionExternalId: event.data.sessionId,
          requestId: event.data.requestId,
          title: event.data.title,
          questions: event.data.questions,
        })
        return
      case 'plan_review_request':
        await this.runMutation('plans.upsertPending', api.plans.upsertPending, {
          sessionExternalId: event.data.sessionId,
          requestId: event.data.requestId,
          name: event.data.name,
          overview: event.data.overview,
          markdown: event.data.markdown,
          todos: event.data.todos,
          phases: event.data.phases,
        })
        return
      case 'plan_update':
        await this.appendPlanUpdate(event)
        return
      case 'subtask_update':
        await this.upsertSubtask(event)
        return
      // Questions and plan reviews clear on their own settlement events. Both
      // used to be cleared off `extension_resolved`, which is emitted only for
      // interactions that travelled over ACP's `_ext` methods — anything else
      // was answered and then left pending forever in Convex, so mobile kept
      // showing a question the user had already dealt with.
      case 'question_resolved':
        await this.runMutation('questions.resolve', api.questions.resolve, {
          requestId: event.data.requestId,
        })
        return
      case 'plan_review_resolved': {
        // The event carries the review outcome itself, so the persisted status
        // no longer has to be reverse-engineered out of a provider's payload.
        const resolution = planResolutionFor(event.data.outcome)
        await this.runMutation('plans.resolve', api.plans.resolve, {
          requestId: event.data.requestId,
          status: resolution.status,
          resolutionReason: resolution.reason,
        })
        return
      }
      case 'current_model_update':
        this.updateRuntime(event.sessionId, { modelId: event.data.currentModelId })
        await this.upsertProviderProfile(event.providerId, { models: event.data })
        return
      case 'current_mode_update':
        this.updateRuntime(event.sessionId, { modeId: event.data.currentModeId })
        await this.upsertProviderProfile(event.providerId, { modes: event.data })
        return
      case 'session_info_update':
        if (workspacePath && event.data.title) {
          await this.runMutation('sessions.upsertTitle', (api as any).sessions.upsertTitle, {
            workspacePath,
            externalId: event.sessionId,
            title: event.data.title,
            source: 'provider',
            providerId: event.providerId,
          })
        }
        return
      case 'rpc_error':
      case 'runtime_error':
      case 'auth_required':
        // A recoverable error is the provider saying "retrying, the turn is
        // still running". Marking the session errored and finalizing the turn
        // here would persist a truncated answer: `finalizeTurn` closes the
        // assistant message, and everything the successful retry then produces
        // arrives for a turn that is already written off.
        if (isRecoverableError(event)) return
        if (event.sessionId && workspacePath) {
          await this.upsertSession(workspacePath, event.sessionId, 'error', event.providerId)
          await this.finalizeTurn(event.threadId, 'error', timestampMs(event.timestamp))
        }
        return
      case 'process_exited':
        await this.finalizeTurn(event.threadId, 'error', timestampMs(event.timestamp))
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
      startedAt: timestampMs(event.timestamp),
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
        source: 'fallback',
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
      await this.finalizeTurn(event.threadId, event.data.stopReason, timestampMs(event.timestamp))
    }
    if (workspacePath)
      await this.upsertSession(workspacePath, event.sessionId, 'idle', event.providerId)
  }

  private async appendAgentChunk(
    event: Extract<AgentEvent, { event: 'agent_message_chunk' | 'agent_thought_chunk' }>,
    reasoning: boolean,
  ): Promise<void> {
    const turn = this.activeTurn(event)
    if (!turn) return
    const buffer = this.buffer(
      turn.assistantMessageId,
      event.sessionId,
      'assistant',
      event.providerId,
      turn.startedAt,
    )
    await this.ensurePlaceholder(turn.assistantMessageId, buffer)
    const closed: string[] = []
    if (reasoning) {
      if (turn.textPartId) closed.push(turn.textPartId)
      turn.textPartId = undefined
    } else {
      const reasoningPartId = this.finishReasoning(turn, buffer)
      if (reasoningPartId) closed.push(reasoningPartId)
    }
    await this.flushParts(turn.assistantMessageId, buffer, closed, event.seq)
    // Part ids key the merge between a Convex snapshot and the live IPC stream
    // on reconnect, so they are derived from the event that opened the run
    // rather than a positional counter: a renderer that starts mid-turn can
    // never mint an id that collides with a run it did not witness.
    if (event.event === 'agent_thought_chunk') {
      await this.appendThoughtChunk(event, turn, buffer)
      return
    }
    const partId = (turn.textPartId ??= `${turn.assistantMessageId}_text_${event.id}`)
    const part = this.appendContent(buffer, partId, event.data.content)
    const text = event.data.content.type === 'text' ? event.data.content.text : ''
    await this.appendChunk(turn.assistantMessageId, buffer, text, {
      partUpdate: { kind: 'part.updated', part },
      coalescePartUpdate: true,
      seq: event.seq,
    })
  }

  /** The persisted mirror of `StreamingMessagesStore.appendThought`.
   *
   * This path used to share `appendContent` with message chunks, which has no
   * empty-text guard where the renderer has one — so a provider whose thinking
   * blocks carry no text (Claude Code) would have persisted an empty reasoning
   * part the live UI never showed, and live and history would disagree the
   * moment the message finalized. Both sides now agree on the same rule: a
   * chunk opens or updates the part when it carries text, a token count, or a
   * `start`, and `stop` closes it. */
  private async appendThoughtChunk(
    event: Extract<AgentEvent, { event: 'agent_thought_chunk' }>,
    turn: ActiveTurn,
    buffer: MessageBuffer,
  ): Promise<void> {
    const { phase, tokens } = event.data
    const text = textFromBlock(event.data.content)
    // `tokens: 0` is a real first reading, so this tests presence, not truth.
    const opens = phase === 'start' || text !== '' || tokens !== undefined
    if (!opens && phase !== 'stop') return
    let part: PartData | undefined
    if (opens) {
      const partId = (turn.reasoningPartId ??= `${turn.assistantMessageId}_reasoning_${event.id}`)
      part = this.appendReasoning(buffer, partId, text, tokens)
    }
    if (phase === 'stop') {
      const closedPartId = this.finishReasoning(turn, buffer)
      if (closedPartId) part = buffer.parts.get(closedPartId) ?? part
    }
    if (!part) return
    await this.appendChunk(turn.assistantMessageId, buffer, '', {
      partUpdate: { kind: 'part.updated', part },
      // A stop is the last word on this part, so it is never coalesced away —
      // dropping it would leave the persisted part without its `time.end` and
      // the reader with a thought that never finished.
      coalescePartUpdate: phase !== 'stop',
      seq: event.seq,
    })
  }

  private appendReasoning(
    buffer: MessageBuffer,
    partId: string,
    text: string,
    tokens: number | undefined,
  ): PartData {
    const existing = buffer.parts.get(partId)
    const previousTokens = typeof existing?.tokens === 'number' ? existing.tokens : undefined
    // estimated_tokens is a cumulative total, never an increment: summing it
    // would multiply the count, and a late duplicate would inflate it.
    const merged = tokens !== undefined ? Math.max(previousTokens ?? 0, tokens) : previousTokens
    const part: PartData = {
      ...(existing ?? {}),
      type: 'reasoning',
      id: partId,
      text: `${String(existing?.text ?? '')}${text}`,
      ...(merged !== undefined ? { tokens: merged } : {}),
      time: (existing?.time as { start: number; end?: number } | undefined) ?? {
        start: Date.now(),
      },
    }
    buffer.parts.set(partId, part)
    return part
  }

  private async updateTool(
    event: Extract<AgentEvent, { event: 'tool_call' | 'tool_call_update' }>,
    tool: ToolCall | ToolCallUpdate,
  ): Promise<void> {
    const turn = this.activeTurn(event)
    if (!turn) return
    const buffer = this.buffer(
      turn.assistantMessageId,
      event.sessionId,
      'assistant',
      event.providerId,
      turn.startedAt,
    )
    await this.ensurePlaceholder(turn.assistantMessageId, buffer)
    await this.flushParts(
      turn.assistantMessageId,
      buffer,
      this.finishActiveParts(turn, buffer),
      event.seq,
    )
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
      seq: event.seq,
    })
  }

  private async appendToolContent(
    event: Extract<AgentEvent, { event: 'tool_call_content' }>,
    toolCallId: string,
    item: ToolCallContent,
  ): Promise<void> {
    const turn = this.activeTurn(event)
    if (!turn) return
    const buffer = this.buffer(
      turn.assistantMessageId,
      event.sessionId,
      'assistant',
      event.providerId,
      turn.startedAt,
    )
    await this.ensurePlaceholder(turn.assistantMessageId, buffer)
    await this.flushParts(
      turn.assistantMessageId,
      buffer,
      this.finishActiveParts(turn, buffer),
      event.seq,
    )
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
      seq: event.seq,
    })
  }

  private async appendPlanUpdate(
    event: Extract<AgentEvent, { event: 'plan_update' }>,
  ): Promise<void> {
    const turn = this.activeTurn(event)
    if (!turn) return
    const buffer = this.buffer(
      turn.assistantMessageId,
      event.sessionId,
      'assistant',
      event.providerId,
      turn.startedAt,
    )
    await this.ensurePlaceholder(turn.assistantMessageId, buffer)
    await this.flushParts(
      turn.assistantMessageId,
      buffer,
      this.finishActiveParts(turn, buffer),
      event.seq,
    )
    const part: PartData = { type: 'plan', id: 'plan', entries: event.data.entries }
    buffer.parts.set('plan', part)
    await this.appendChunk(turn.assistantMessageId, buffer, '', {
      partUpdate: { kind: 'part.updated', part },
      seq: event.seq,
    })
  }

  private async upsertSubtask(
    event: Extract<AgentEvent, { event: 'subtask_update' }>,
  ): Promise<void> {
    const turn = this.activeTurn(event)
    if (!turn) return
    const buffer = this.buffer(
      turn.assistantMessageId,
      event.sessionId,
      'assistant',
      event.providerId,
      turn.startedAt,
    )
    await this.ensurePlaceholder(turn.assistantMessageId, buffer)
    await this.flushParts(
      turn.assistantMessageId,
      buffer,
      this.finishActiveParts(turn, buffer),
      event.seq,
    )
    const data = event.data
    const existing = buffer.parts.get(data.taskId)
    // Late metadata (e.g. cursor/task) arrives statusless after the terminal
    // update; never let a stale non-terminal status regress a settled subtask.
    const acceptsStatus =
      !!data.status &&
      !(isTerminalSubtaskStatus(existing?.status) && !isTerminalSubtaskStatus(data.status))
    const assign: Partial<SubtaskUpdate> & { targetSessionId?: string } = {
      ...(acceptsStatus
        ? {
            status: data.status,
            ...(data.statusSource ? { statusSource: data.statusSource } : {}),
            ...(data.statusReason ? { statusReason: data.statusReason } : {}),
          }
        : {}),
      ...(data.title ? { title: data.title } : {}),
      ...(data.description ? { description: data.description } : {}),
      ...(data.prompt ? { prompt: data.prompt } : {}),
      ...(data.subagentType ? { subagentType: data.subagentType } : {}),
      ...(data.modelId ? { modelId: data.modelId } : {}),
      ...(data.childSessionId ? { targetSessionId: data.childSessionId } : {}),
      ...(data.durationMs !== undefined ? { durationMs: data.durationMs } : {}),
      ...(data.resultText ? { resultText: data.resultText } : {}),
      ...(data.currentActivity ? { currentActivity: data.currentActivity } : {}),
      ...(data.toolCallCount !== undefined ? { toolCallCount: data.toolCallCount } : {}),
    }
    const part: PartData = {
      ...(existing ?? { status: 'pending' }),
      ...assign,
      type: 'subtask',
      id: data.taskId,
    }
    buffer.parts.set(part.id, part)
    await this.appendChunk(turn.assistantMessageId, buffer, '', {
      partUpdate: { kind: 'part.updated', part },
      seq: event.seq,
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
    await this.runMutation('permissions.upsertPending', api.permissions.upsertPending, {
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
      options: permission.options,
      expiresAt: permission.expiresAt ? Date.parse(permission.expiresAt) : undefined,
    })
  }

  private activeTurn(event: AgentEvent & { sessionId: string }): ActiveTurn | undefined {
    const turn = this.turns.get(event.threadId)
    if (!turn || !event.messageId || turn.assistantMessageId !== event.messageId) return undefined
    return turn
  }

  private buffer(
    messageId: string,
    sessionExternalId: string,
    role: string,
    providerId: string,
    startedAt: number,
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
        runtimeMetadata: { providerId, startedAt },
        pendingPartUpdates: new Map(),
      }
      this.buffers.set(messageId, buffer)
    }
    return buffer
  }

  private appendContent(buffer: MessageBuffer, partId: string, content: ContentBlock): PartData {
    const existing = buffer.parts.get(partId)
    let part: PartData
    if (content.type === 'text') {
      part = {
        ...(existing ?? {}),
        type: 'text',
        id: partId,
        text: `${String(existing?.text ?? '')}${content.text}`,
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
      seq?: number
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
      ...(options.seq !== undefined ? { seq: options.seq } : {}),
    })
  }

  // Coalescing may have skipped the most recent update of a part that is now
  // closed; nothing will ever revisit it, so persist it before moving on. This
  // is what lets a chunk claim its event sequence as fully covered, and what
  // keeps a snapshot rebuilt from chunks complete rather than trailing by up to
  // PART_UPDATE_CHUNK_INTERVAL updates.
  private async flushParts(
    messageId: string,
    buffer: MessageBuffer,
    partIds: string[],
    seq?: number,
  ): Promise<void> {
    const dirty = partIds.filter((partId) => (buffer.pendingPartUpdates.get(partId) ?? 0) > 0)
    if (dirty.length === 0) return
    for (const partId of dirty) buffer.pendingPartUpdates.set(partId, 0)
    for (const partId of dirty) {
      const part = buffer.parts.get(partId)
      if (!part) continue
      await this.appendChunk(messageId, buffer, '', {
        partUpdate: { kind: 'part.updated', part },
        seq,
      })
    }
  }

  private async finalizeTurn(
    threadId: string,
    stopReason?: string,
    completedAt = Date.now(),
  ): Promise<void> {
    const turn = this.turns.get(threadId)
    if (!turn) return
    const buffer = this.buffers.get(turn.assistantMessageId)
    if (buffer) {
      buffer.runtimeMetadata = {
        ...buffer.runtimeMetadata,
        ...(stopReason ? { finishReason: stopReason } : {}),
        startedAt: turn.startedAt,
        completedAt,
      }
      this.finishActiveParts(turn, buffer)
      this.finishRunningTools(buffer, stopReason)
      this.finishRunningSubtasks(buffer, stopReason)
      await this.finalize(turn.assistantMessageId, buffer)
    }
    this.turns.delete(threadId)
  }

  /** Returns the closed part id so callers can flush it; see flushParts. */
  private finishReasoning(turn: ActiveTurn, buffer: MessageBuffer): string | undefined {
    const partId = turn.reasoningPartId
    turn.reasoningPartId = undefined
    if (!partId) return undefined
    const part = buffer.parts.get(partId)
    if (!part) return undefined
    const time =
      part.time && typeof part.time === 'object'
        ? (part.time as Record<string, number>)
        : { start: Date.now() }
    buffer.parts.set(partId, { ...part, time: { ...time, end: time.end ?? Date.now() } })
    return partId
  }

  private finishActiveParts(turn: ActiveTurn, buffer: MessageBuffer): string[] {
    const closed = turn.textPartId ? [turn.textPartId] : []
    turn.textPartId = undefined
    const reasoningPartId = this.finishReasoning(turn, buffer)
    return reasoningPartId ? [...closed, reasoningPartId] : closed
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

  private finishRunningSubtasks(buffer: MessageBuffer, stopReason?: string): void {
    const settlement = subtaskStatusFromTurnResult(stopReason)
    for (const [id, part] of buffer.parts) {
      if (part.type !== 'subtask' || isTerminalSubtaskStatus(part.status)) continue
      buffer.parts.set(id, { ...part, ...settlement })
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

  private async upsertProviderProfile(
    providerId: AgentEvent['providerId'],
    source: {
      agentInfo?: { name?: string; version?: string }
      models?: ModelListing
      modes?: ModeListing
      includeDefaults?: boolean
    },
  ): Promise<void> {
    const availableModels = source.models?.availableModels?.map((model) => ({
      modelId: model.id,
      name: model.displayName,
      ...(model.description !== undefined ? { description: model.description } : {}),
      ...(model.contextWindowTokens !== undefined
        ? { contextWindowTokens: model.contextWindowTokens }
        : {}),
      // Persisted so a restored profile can still gate the effort pill and the
      // `auto` permission mode before the provider is probed again.
      ...(model.effortLevels?.length ? { effortLevels: model.effortLevels } : {}),
      ...(model.supportsFastMode ? { supportsFastMode: true } : {}),
      ...(model.supportsAutoMode ? { supportsAutoMode: true } : {}),
    }))
    const availableModes = source.modes?.availableModes?.map((mode) => ({
      id: mode.id,
      name: mode.displayName,
      ...(mode.description !== undefined ? { description: mode.description } : {}),
    }))
    const args = {
      providerId,
      ...(source.agentInfo ? { agentInfo: source.agentInfo } : {}),
      ...(availableModels?.length ? { availableModels } : {}),
      ...(availableModes?.length ? { availableModes } : {}),
      ...(source.includeDefaults && source.models?.currentModelId
        ? { defaultModelId: source.models.currentModelId }
        : {}),
      ...(source.includeDefaults && source.modes?.currentModeId
        ? { defaultModeId: source.modes.currentModeId }
        : {}),
    }
    if (Object.keys(args).length === 1) return
    // The mutation is a server-side no-op for unchanged data; this local cache
    // just avoids issuing repeat round-trips for identical payloads.
    const serialized = JSON.stringify(args)
    if (this.sentProfileByProvider.get(providerId) === serialized) return
    this.sentProfileByProvider.set(providerId, serialized)
    await this.runMutation('composer.upsertProfile', (api as any).composer.upsertProfile, args)
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
