import { ConvexClient } from 'convex/browser'
import { BrowserWindow } from 'electron'
import { api } from '@convex/_generated/api'
import {
  estimateConvexPayloadBytes,
  extractConvexTelemetryContext,
  recordConvexTelemetry,
} from './convex-telemetry'

interface PartData {
  type: string
  id: string
  [key: string]: unknown
}

interface MessageBuffer {
  content: string
  sessionExternalId: string
  role: string
  parts: Map<string, PartData>
  placeholderInserted: boolean
  placeholderInFlight: boolean
  chunkIndex: number
  flushedLength: number
}

interface RuntimeMetadata {
  providerId?: string
  modelId?: string
  modeId?: string
  agentId?: string
  finishReason?: string
  costUsd?: number
  tokens?: {
    input?: number
    output?: number
    reasoning?: number
    cacheRead?: number
    cacheWrite?: number
    total?: number
  }
}

function isPlaceholderSessionTitle(title: string | undefined): boolean {
  if (!title) return true
  const trimmed = title.trim()
  if (!trimmed) return true
  if (/^ACP Session\s+[0-9a-f-]{8,}$/i.test(trimmed)) return true
  if (/^New session\s*-\s*\d+$/i.test(trimmed)) return true
  if (/^session[-_\s]?[0-9a-z]{6,}$/i.test(trimmed)) return true
  return false
}

export class SSEBridge {
  private controller: AbortController | null = null
  private buffers = new Map<string, MessageBuffer>()
  private messageRuntime = new Map<string, RuntimeMetadata>()
  private cursorFlushQueues = new Map<string, Promise<void>>()
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private stopped = true

  constructor(
    private serverUrl: string,
    private password: string,
    private workspacePath: string,
    private convex: ConvexClient,
    private mainWindow: BrowserWindow,
    private clientId: string,
  ) {}

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    console.log(`[sse-bridge] starting for ${this.workspacePath}`)
    void this.connect()
  }

  stop(): void {
    this.stopped = true
    this.controller?.abort()
    this.controller = null
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.cursorFlushQueues.clear()
  }

  private scheduleReconnect(delayMs: number): void {
    if (this.stopped) return
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.stopped) return
      void this.connect()
    }, delayMs)
  }

  private async connect(): Promise<void> {
    if (this.stopped) return
    this.controller = new AbortController()
    try {
      const credentials = Buffer.from(`opencode:${this.password}`).toString('base64')
      const res = await fetch(`${this.serverUrl}/global/event`, {
        headers: {
          Authorization: `Basic ${credentials}`,
          Accept: 'text/event-stream',
        },
        signal: this.controller.signal,
      })
      if (!res.ok || !res.body) {
        const body = await res.text().catch(() => '')
        throw new Error(`SSE connection failed: ${res.status} ${body.slice(0, 200)}`)
      }
      console.log(`[sse-bridge] connected to ${this.serverUrl}/global/event`)
      await this.readStream(res.body)
    } catch (err) {
      if ((err as Error).name === 'AbortError') return
      console.warn(`[sse-bridge] connection error: ${(err as Error).message}`)
      this.scheduleReconnect(2000)
    }
  }

  private async readStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let eventData = ''

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          const normalizedLine = line.endsWith('\r') ? line.slice(0, -1) : line
          if (normalizedLine.startsWith('data:')) {
            eventData += (eventData ? '\n' : '') + normalizedLine.slice(5).trim()
          } else if (normalizedLine === '' && eventData) {
            console.log('\n' + '='.repeat(80))
            console.log('[SSE] RAW EVENT CAPTURED')
            console.log('-'.repeat(80))
            console.log(eventData)
            console.log('-'.repeat(80))
            this.handleEvent(eventData)
            eventData = ''
          }
        }
      }
    } finally {
      reader.releaseLock()
    }
    this.scheduleReconnect(1000)
  }

  private getOrCreateBuffer(messageId: string, sessionId: string, role = 'assistant'): MessageBuffer {
    let buf = this.buffers.get(messageId)
    if (!buf) {
      buf = {
        content: '',
        sessionExternalId: sessionId,
        role,
        parts: new Map(),
        placeholderInserted: false,
        placeholderInFlight: false,
        chunkIndex: 0,
        flushedLength: 0,
      }
      this.buffers.set(messageId, buf)
    }
    return buf
  }

  private rebuildContent(parts: Map<string, PartData>): string {
    const textParts: string[] = []
    for (const p of parts.values()) {
      if (p.type === 'text' && typeof p.text === 'string') textParts.push(p.text)
    }
    return textParts.join('')
  }

  private normalizeParts(rawParts: PartData[]): PartData[] {
    const seen = new Set<string>()
    return rawParts
      .filter((part) => {
        const id = part.id ?? (part as { callID?: string }).callID
        if (id && seen.has(id)) return false
        if (id) seen.add(id)
        return true
      })
      .map((part) => ({
        ...part,
        id: part.id ?? (part as { callID?: string }).callID ?? crypto.randomUUID(),
      }))
  }

  private async ensureAssistantPlaceholder(messageId: string, sessionExternalId: string): Promise<void> {
    const buffer = this.getOrCreateBuffer(messageId, sessionExternalId)
    if (buffer.placeholderInserted || buffer.placeholderInFlight) return
    buffer.placeholderInFlight = true
    try {
      const inserted = await this.runTrackedMutation('messages.insertPlaceholder', api.messages.insertPlaceholder, {
        sessionExternalId,
        externalId: messageId,
        role: buffer.role,
      })
      if (inserted) {
        buffer.placeholderInserted = true
      }
    } catch (err) {
      console.warn('[sse-bridge] placeholder insert failed:', (err as Error).message)
    } finally {
      buffer.placeholderInFlight = false
    }
  }

  private forwardDelta(payload: {
    sessionExternalId: string
    messageExternalId: string
    delta?: string
    partId?: string
    field?: string
    part?: Record<string, unknown>
  }): void {
    if (this.mainWindow.isDestroyed()) return
    this.mainWindow.webContents.send('stream:token', payload)
  }

  private getSentenceBoundaryLength(content: string, flushedLength: number): number {
    const pending = content.slice(flushedLength)
    let boundaryLength = 0

    for (let index = 0; index < pending.length; index += 1) {
      const char = pending[index]
      const nextChar = pending[index + 1]
      if (char === '\n' || char === '.' || char === '!' || char === '?') {
        if (nextChar === undefined || /\s/.test(nextChar)) {
          boundaryLength = index + 1
        }
      }
    }

    return boundaryLength
  }

  private async flushCursorChunk(messageId: string, isFinal: boolean): Promise<void> {
    const buffer = this.buffers.get(messageId)
    if (!buffer) return

    const boundaryLength = isFinal
      ? buffer.content.length - buffer.flushedLength
      : this.getSentenceBoundaryLength(buffer.content, buffer.flushedLength)
    if (boundaryLength <= 0) return

    const chunkText = buffer.content.slice(buffer.flushedLength, buffer.flushedLength + boundaryLength)
    if (!chunkText) return

    buffer.chunkIndex += 1
    buffer.flushedLength += boundaryLength

    try {
      await this.runTrackedMutation('streamCursors.upsert', api.streamCursors.upsert, {
        messageExternalId: messageId,
        sessionExternalId: buffer.sessionExternalId,
        chunkIndex: buffer.chunkIndex,
        chunkText,
        bodyUpToHere: buffer.content,
        partsUpToHere: Array.from(buffer.parts.values()),
      })
    } catch (err) {
      console.warn('[sse-bridge] cursor update failed:', (err as Error).message)
    }
  }

  private enqueueCursorFlush(messageId: string, isFinal: boolean): Promise<void> {
    const previous = this.cursorFlushQueues.get(messageId) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(() => this.flushCursorChunk(messageId, isFinal))
    const tracked = next.finally(() => {
      if (this.cursorFlushQueues.get(messageId) === tracked) {
        this.cursorFlushQueues.delete(messageId)
      }
    })
    this.cursorFlushQueues.set(messageId, tracked)
    return tracked
  }

  private async runTrackedMutation(name: string, mutationRef: any, args: Record<string, unknown>) {
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

  private async finalizeAssistantMessage(messageId: string): Promise<void> {
    const buffer = this.buffers.get(messageId)
    if (!buffer) return

    await this.enqueueCursorFlush(messageId, true)

    try {
      const finalized = await this.runTrackedMutation('messages.finalize', api.messages.finalize, {
        sessionExternalId: buffer.sessionExternalId,
        externalId: messageId,
        content: buffer.content,
        role: buffer.role,
        parts: Array.from(buffer.parts.values()),
        runtimeMetadata: this.messageRuntime.get(messageId),
      })
      if (!finalized) {
        console.warn('[sse-bridge] finalize skipped: message/session missing')
        return
      }
      await this.runTrackedMutation('streamCursors.remove', api.streamCursors.remove, {
        messageExternalId: messageId,
      })
    } catch (err) {
      console.warn('[sse-bridge] finalize failed:', (err as Error).message)
      return
    }

    this.buffers.delete(messageId)
    this.messageRuntime.delete(messageId)
  }

  private async upsertFinalizedMessage(args: {
    sessionExternalId: string
    externalId: string
    content: string
    role: string
    parts?: PartData[]
    runtimeMetadata?: RuntimeMetadata
  }): Promise<void> {
    try {
      await this.runTrackedMutation('messages.upsertFinalized', api.messages.upsertFinalized, args)
      this.messageRuntime.delete(args.externalId)
    } catch (err) {
      console.warn('[sse-bridge] finalized write failed:', (err as Error).message)
    }
  }

  private extractRuntimeMetadata(info: Record<string, any>): RuntimeMetadata | undefined {
    const providerId =
      typeof info.providerID === 'string'
        ? info.providerID
        : typeof info.model?.providerID === 'string'
          ? info.model.providerID
          : undefined
    const modelId =
      typeof info.modelID === 'string'
        ? info.modelID
        : typeof info.model?.modelID === 'string'
          ? info.model.modelID
          : undefined
    const modeId = typeof info.mode === 'string' ? info.mode : undefined
    const agentId = typeof info.agent === 'string' ? info.agent : undefined
    const finishReason = typeof info.finish === 'string' ? info.finish : typeof info.stopReason === 'string' ? info.stopReason : undefined
    const costUsd = typeof info.cost === 'number' ? info.cost : undefined
    const tokens = info.tokens && typeof info.tokens === 'object' ? info.tokens : undefined
    const runtime: RuntimeMetadata = {
      ...(providerId ? { providerId } : {}),
      ...(modelId ? { modelId } : {}),
      ...(modeId ? { modeId } : {}),
      ...(agentId ? { agentId } : {}),
      ...(finishReason ? { finishReason } : {}),
      ...(typeof costUsd === 'number' ? { costUsd } : {}),
      ...(tokens
        ? {
            tokens: {
              ...(typeof tokens.input === 'number' ? { input: tokens.input } : {}),
              ...(typeof tokens.output === 'number' ? { output: tokens.output } : {}),
              ...(typeof tokens.reasoning === 'number' ? { reasoning: tokens.reasoning } : {}),
              ...(typeof tokens.cache?.read === 'number' ? { cacheRead: tokens.cache.read } : {}),
              ...(typeof tokens.cache?.write === 'number' ? { cacheWrite: tokens.cache.write } : {}),
              ...(typeof tokens.total === 'number' ? { total: tokens.total } : {}),
            },
          }
        : {}),
    }

    const hasData =
      !!runtime.providerId ||
      !!runtime.modelId ||
      !!runtime.modeId ||
      !!runtime.agentId ||
      !!runtime.finishReason ||
      typeof runtime.costUsd === 'number' ||
      (runtime.tokens && Object.keys(runtime.tokens).length > 0)
    return hasData ? runtime : undefined
  }

  private buildCandidateTitleFromMessage(info: Record<string, any>): string | null {
    const summaryTitle = typeof info.summary?.title === 'string' ? info.summary.title.trim() : ''
    if (summaryTitle && !isPlaceholderSessionTitle(summaryTitle)) return summaryTitle

    const textPart = Array.isArray(info.parts)
      ? info.parts.find((part: any) => part?.type === 'text' && typeof part.text === 'string')
      : null
    const text = typeof textPart?.text === 'string' ? textPart.text.trim() : ''
    if (!text) return null
    const singleLine = text.replace(/\s+/g, ' ').trim()
    if (!singleLine) return null
    return singleLine.length > 80 ? `${singleLine.slice(0, 77)}...` : singleLine
  }

  private emitSSEEvent(payload: {
    id: string
    timestamp: string
    eventType: string
    role: string
    messageId?: string
    sessionId?: string
    raw: string
    envelope: Record<string, unknown>
  }): void {
    if (this.mainWindow.isDestroyed()) return
    this.mainWindow.webContents.send('sse:event', payload)
  }

  public ingestEnvelope(envelope: Record<string, unknown>, raw = ''): void {
    this.processEnvelope(envelope, raw)
  }

  private handleEvent(data: string): void {
    try {
      const envelope = JSON.parse(data)
      this.processEnvelope(envelope, data)
    } catch (err) {
      console.warn('[sse-bridge] parse error:', (err as Error).message)
    }
  }

  private processEnvelope(envelope: Record<string, any>, raw: string): void {
    const eventType: string | undefined = envelope.payload?.type
    const props = envelope.payload?.properties

    console.log('\n' + '#'.repeat(80))
    console.log('[SSE] PARSED EVENT')
    console.log('#'.repeat(80))
    console.log('  Event type:', eventType ?? '(none)')
    console.log('  Has props:', !!props)
    if (props) {
      console.log('  Properties (summary):', JSON.stringify(props, null, 2))
    }
    console.log('  Full envelope:', JSON.stringify(envelope, null, 2))
    console.log('#'.repeat(80) + '\n')

    if (!eventType || !props) return

    switch (eventType) {
        case 'session.updated':
        case 'session.created': {
          const info = props.info
          if (!info?.id) break
          const title = info.title ?? info.slug ?? info.id
          const status = info.status?.type ?? 'idle'
          void this.runTrackedMutation('sessions.upsertStatus', api.sessions.upsertStatus, {
              workspacePath: this.workspacePath,
              externalId: info.id,
              status,
              title,
              clientId: this.clientId,
            })
            .catch((err) =>
              console.warn('[sse-bridge] session upsert failed:', (err as Error).message),
            )
          break
        }

        case 'session.deleted': {
          const info = props.info
          if (!info?.id) break
          void this.runTrackedMutation('sessions.remove', api.sessions.remove, {
              externalId: info.id,
            })
            .catch((err) =>
              console.warn('[sse-bridge] session remove failed:', (err as Error).message),
            )
          break
        }

        case 'session.status': {
          const sid: string = props.sessionID
          if (!sid) break
          const statusObj = props.status
          const status = statusObj?.type ?? 'idle'
          void this.runTrackedMutation('sessions.upsertStatus', api.sessions.upsertStatus, {
              workspacePath: this.workspacePath,
              externalId: sid,
              status,
              clientId: this.clientId,
            })
            .catch((err) =>
              console.warn('[sse-bridge] session status failed:', (err as Error).message),
            )
          break
        }

        case 'session.error': {
          const sid: string = props.sessionID
          if (!sid) break
          void this.runTrackedMutation('sessions.upsertStatus', api.sessions.upsertStatus, {
              workspacePath: this.workspacePath,
              externalId: sid,
              status: 'error',
              clientId: this.clientId,
            })
            .catch((err) =>
              console.warn('[sse-bridge] session error status failed:', (err as Error).message),
            )
          break
        }

        case 'message.updated': {
          const info = props.info
          if (!info?.id || !info?.sessionID) break
          const isFinal = !!info.time?.completed
          const role = info.role ?? 'assistant'
          const runtimeMetadata = this.extractRuntimeMetadata(info)
          if (runtimeMetadata) {
            this.messageRuntime.set(info.id, runtimeMetadata)
          }
          const partsArray = this.normalizeParts((info.parts ?? []) as PartData[])

          if (role === 'assistant') {
            const buffer = this.getOrCreateBuffer(info.id, info.sessionID, role)

            if (!buffer.content && partsArray.length > 0) {
              for (const part of partsArray) {
                buffer.parts.set(part.id, part)
              }
              buffer.content = this.rebuildContent(buffer.parts)
            }

            if (!isFinal) {
              void this.ensureAssistantPlaceholder(info.id, info.sessionID)
            } else {
              void this.finalizeAssistantMessage(info.id)
            }
            break
          }

          const buffer = this.getOrCreateBuffer(info.id, info.sessionID, role)
          if (partsArray.length > 0) {
            for (const part of partsArray) {
              buffer.parts.set(part.id, part)
            }
            buffer.content = this.rebuildContent(buffer.parts)
          }

          const finalizedParts = Array.from(buffer.parts.values())
          const content = buffer.content

          if (content || finalizedParts.length > 0) {
            void this.upsertFinalizedMessage({
              sessionExternalId: info.sessionID,
              externalId: info.id,
              content,
              role,
              parts: finalizedParts,
              runtimeMetadata: runtimeMetadata ?? this.messageRuntime.get(info.id),
            })
          }

          if (isFinal && role === 'user') {
            const candidateTitle = this.buildCandidateTitleFromMessage(info)
            if (candidateTitle && !isPlaceholderSessionTitle(candidateTitle)) {
              void this.runTrackedMutation('sessions.upsertTitle', (api as any).sessions.upsertTitle, {
                  workspacePath: this.workspacePath,
                  externalId: info.sessionID,
                  title: candidateTitle,
                  clientId: this.clientId,
                })
                .catch((err) =>
                  console.warn('[sse-bridge] session title promote failed:', (err as Error).message),
                )
            }
          }
          break
        }

        case 'message.removed': {
          const msgId: string = props.messageID
          if (!msgId) break
          this.buffers.delete(msgId)
          this.messageRuntime.delete(msgId)
          void this.runTrackedMutation('messages.removeByExternalId', api.messages.removeByExternalId, {
              externalId: msgId,
            })
            .catch((err) =>
              console.warn('[sse-bridge] message remove failed:', (err as Error).message),
            )
          break
        }

        case 'message.part.updated': {
          const part = props.part
          if (!part?.messageID || !part?.sessionID) break
          const existingBuffer = this.buffers.get(part.messageID)
          const role = existingBuffer?.role ?? 'assistant'
          const buf = this.getOrCreateBuffer(part.messageID, part.sessionID, role)
          const partId = part.id ?? (part as { callID?: string }).callID ?? `${part.type}_${buf.parts.size}`
          buf.parts.set(partId, { ...part, id: partId })
          buf.content = this.rebuildContent(buf.parts)

          if (buf.role !== 'assistant') {
            void this.upsertFinalizedMessage({
              sessionExternalId: part.sessionID,
              externalId: part.messageID,
              content: buf.content,
              role: buf.role,
              parts: Array.from(buf.parts.values()),
              runtimeMetadata: this.messageRuntime.get(part.messageID),
            })
            break
          }

          void this.ensureAssistantPlaceholder(part.messageID, part.sessionID)
          this.forwardDelta({
            sessionExternalId: part.sessionID,
            messageExternalId: part.messageID,
            part: { ...part, id: partId },
          })
          void this.enqueueCursorFlush(part.messageID, false)
          break
        }

        case 'message.part.delta': {
          const msgId: string = props.messageID
          const sid: string = props.sessionID
          const partId: string = props.partID
          const field: string = props.field
          const delta: string = props.delta ?? ''
          if (!msgId || !sid || !delta) break

          const existingBuffer = this.buffers.get(msgId)
          const role = existingBuffer?.role ?? 'assistant'
          const buf = this.getOrCreateBuffer(msgId, sid, role)
          const existing = buf.parts.get(partId)
          if (existing) {
            ;(existing as Record<string, unknown>)[field] =
              ((existing as Record<string, unknown>)[field] as string ?? '') + delta
          } else {
            buf.parts.set(partId, { type: 'text', id: partId, [field]: delta })
          }
          buf.content = this.rebuildContent(buf.parts)

          if (buf.role !== 'assistant') {
            void this.upsertFinalizedMessage({
              sessionExternalId: sid,
              externalId: msgId,
              content: buf.content,
              role: buf.role,
              parts: Array.from(buf.parts.values()),
              runtimeMetadata: this.messageRuntime.get(msgId),
            })
            break
          }

          void this.ensureAssistantPlaceholder(msgId, sid)
          this.forwardDelta({
            sessionExternalId: sid,
            messageExternalId: msgId,
            delta,
            partId,
            field,
          })
          void this.enqueueCursorFlush(msgId, false)
          break
        }

        case 'permission.asked': {
          const sid: string = props.sessionID
          const requestId: string = props.requestID ?? props.id
          if (!sid || !requestId) break
          const toolRef = props.tool
          const toolName =
            typeof toolRef === 'string'
              ? toolRef
              : typeof props.permission === 'string'
                ? props.permission
                : 'unknown'
          const metadata = props.metadata && typeof props.metadata === 'object' ? props.metadata : undefined
          const targetPath =
            typeof metadata?.filepath === 'string'
              ? metadata.filepath
              : typeof metadata?.parentDir === 'string'
                ? metadata.parentDir
                : undefined
          const description =
            (typeof metadata?.title === 'string' && metadata.title) ||
            (targetPath ? `${toolName} access requested for ${targetPath}` : `${toolName} requires permission`)
          void this.runTrackedMutation(
            'permissions.upsertPending',
            (api as any).permissions.upsertPending,
            {
              sessionExternalId: sid,
              requestId,
              permission: props.permission,
              toolName,
              description,
              input: props.input ?? metadata ?? toolRef,
              patterns: props.patterns,
              alwaysPatterns: props.always,
            },
          ).catch((err) =>
            console.warn('[sse-bridge] permission upsert failed:', (err as Error).message),
          )
          break
        }

        case 'permission.replied': {
          const requestId: string = props.requestID ?? props.id
          if (!requestId) break
          void this.runTrackedMutation('permissions.resolve', (api as any).permissions.resolve, {
              requestId,
            })
            .catch((err) =>
              console.warn('[sse-bridge] permission cleanup failed:', (err as Error).message),
            )
          break
        }

        case 'server.heartbeat':
        case 'project.updated':
        case 'session.diff':
        case 'session.idle':
        case 'session.compacted':
        case 'lsp.updated':
        case 'vcs.branch.updated':
        case 'todo.updated':
          break

      default:
        console.log(`[sse-bridge] unhandled: ${eventType}`)
        break
    }

    if (raw) {
      this.emitSSEEvent({
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        eventType,
        role: 'assistant',
        messageId: props?.messageID ?? props?.part?.messageID,
        sessionId: props?.sessionID ?? props?.part?.sessionID,
        raw,
        envelope,
      })
    }
  }
}
