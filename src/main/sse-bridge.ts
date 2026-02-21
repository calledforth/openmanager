import { ConvexClient } from 'convex/browser'
import { api } from '@convex/_generated/api'

const BATCH_FLUSH_MS = 150

interface PartData {
  type: string
  id: string
  [key: string]: unknown
}

interface MessageBuffer {
  content: string
  sessionExternalId: string
  role: string
  sequenceNum: number
  parts: Map<string, PartData>
}

export class SSEBridge {
  private controller: AbortController | null = null
  private buffers = new Map<string, MessageBuffer>()
  private flushTimer: ReturnType<typeof setInterval> | null = null
  private seqCounters = new Map<string, number>()

  constructor(
    private serverUrl: string,
    private password: string,
    private workspacePath: string,
    private convex: ConvexClient,
  ) {}

  start(): void {
    console.log(`[sse-bridge] starting for ${this.workspacePath}`)
    this.flushTimer = setInterval(() => this.flushAll(), BATCH_FLUSH_MS)
    this.connect()
  }

  stop(): void {
    this.controller?.abort()
    this.controller = null
    if (this.flushTimer) clearInterval(this.flushTimer)
    this.flushAll()
  }

  private nextSeq(sessionId: string): number {
    const n = (this.seqCounters.get(sessionId) ?? -1) + 1
    this.seqCounters.set(sessionId, n)
    return n
  }

  private async connect(): Promise<void> {
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
      setTimeout(() => this.connect(), 2000)
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
          if (line.startsWith('data:')) {
            eventData += (eventData ? '\n' : '') + line.slice(5).trim()
          } else if (line === '' && eventData) {
            this.handleEvent(eventData)
            eventData = ''
          }
        }
      }
    } finally {
      reader.releaseLock()
    }
    setTimeout(() => this.connect(), 1000)
  }

  private getOrCreateBuffer(messageId: string, sessionId: string, role = 'assistant'): MessageBuffer {
    let buf = this.buffers.get(messageId)
    if (!buf) {
      buf = {
        content: '',
        sessionExternalId: sessionId,
        role,
        sequenceNum: this.nextSeq(sessionId),
        parts: new Map(),
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

  private handleEvent(data: string): void {
    try {
      const envelope = JSON.parse(data)
      const eventType: string = envelope.payload?.type
      const props = envelope.payload?.properties
      if (!eventType || !props) return

      switch (eventType) {
        case 'session.updated':
        case 'session.created': {
          const info = props.info
          if (!info?.id) break
          const title = info.title ?? info.slug ?? info.id
          this.convex.action(api.streaming.updateSessionStatus, {
            workspacePath: this.workspacePath,
            externalId: info.id,
            status: info.status?.type ?? 'idle',
            title,
          })
          break
        }

        case 'session.deleted': {
          const info = props.info
          if (!info?.id) break
          this.convex.action(api.streaming.deleteSession, {
            externalId: info.id,
          })
          break
        }

        case 'session.status': {
          const sid: string = props.sessionID
          if (!sid) break
          const statusObj = props.status
          const status = statusObj?.type ?? 'idle'
          this.convex.action(api.streaming.updateSessionStatus, {
            workspacePath: this.workspacePath,
            externalId: sid,
            status,
          })
          break
        }

        case 'session.error': {
          const sid: string = props.sessionID
          if (!sid) break
          this.convex.action(api.streaming.updateSessionStatus, {
            workspacePath: this.workspacePath,
            externalId: sid,
            status: 'error',
          })
          break
        }

        case 'message.updated': {
          const info = props.info
          if (!info?.id || !info?.sessionID) break
          const rawParts = info.parts ?? []
          const textParts = rawParts.filter((p: { type: string }) => p.type === 'text')
          const content = textParts.map((p: { text: string }) => p.text ?? '').join('')
          const isFinal = !!info.time?.completed

          const seen = new Set<string>()
          const partsArray = rawParts
            .filter((p: PartData) => {
              const id = p.id ?? (p as { callID?: string }).callID
              if (id && seen.has(id)) return false
              if (id) seen.add(id)
              return true
            })
            .map((p: PartData) => ({
              ...p,
              id: p.id ?? (p as { callID?: string }).callID ?? crypto.randomUUID(),
            }))

          this.convex.action(api.streaming.flushMessageBatch, {
            sessionExternalId: info.sessionID,
            messageExternalId: info.id,
            content: content || info.summary?.title || '',
            role: info.role ?? 'assistant',
            isFinal,
            sequenceNum: this.nextSeq(info.sessionID),
            parts: partsArray.length > 0 ? partsArray : undefined,
          })

          if (isFinal) this.buffers.delete(info.id)
          break
        }

        case 'message.removed': {
          const msgId: string = props.messageID
          if (!msgId) break
          this.buffers.delete(msgId)
          this.convex.action(api.streaming.deleteMessage, {
            messageExternalId: msgId,
          })
          break
        }

        case 'message.part.updated': {
          const part = props.part
          if (!part?.messageID || !part?.sessionID) break
          const buf = this.getOrCreateBuffer(part.messageID, part.sessionID)
          const partId = part.id ?? (part as { callID?: string }).callID ?? `${part.type}_${buf.parts.size}`
          buf.parts.set(partId, { ...part, id: partId })
          buf.content = this.rebuildContent(buf.parts)
          break
        }

        case 'message.part.delta': {
          const msgId: string = props.messageID
          const sid: string = props.sessionID
          const partId: string = props.partID
          const field: string = props.field
          const delta: string = props.delta ?? ''
          if (!msgId || !sid || !delta) break

          const buf = this.getOrCreateBuffer(msgId, sid)
          const existing = buf.parts.get(partId)
          if (existing) {
            ;(existing as Record<string, unknown>)[field] =
              ((existing as Record<string, unknown>)[field] as string ?? '') + delta
          } else {
            buf.parts.set(partId, { type: 'text', id: partId, [field]: delta })
          }
          buf.content = this.rebuildContent(buf.parts)
          break
        }

        case 'permission.asked': {
          const sid: string = props.sessionID
          const requestId: string = props.requestID
          if (!sid || !requestId) break
          const permPayload = JSON.stringify({
            type: 'permission_request',
            permissionId: requestId,
            toolName: props.tool ?? 'unknown',
            description: props.metadata?.title ?? `${props.tool} requires permission`,
            input: props.input,
          })
          this.convex.action(api.streaming.flushMessageBatch, {
            sessionExternalId: sid,
            messageExternalId: `perm_${requestId}`,
            content: permPayload,
            role: 'permission',
            isFinal: false,
            sequenceNum: this.nextSeq(sid),
          })
          break
        }

        case 'permission.replied': {
          const requestId: string = props.requestID
          if (!requestId) break
          this.convex.action(api.streaming.deleteMessage, {
            messageExternalId: `perm_${requestId}`,
          })
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
    } catch (err) {
      console.warn('[sse-bridge] parse error:', (err as Error).message)
    }
  }

  private async flushMessage(messageId: string, isFinal: boolean): Promise<void> {
    const buf = this.buffers.get(messageId)
    if (!buf) return
    const partsArray = Array.from(buf.parts.values())
    try {
      await this.convex.action(api.streaming.flushMessageBatch, {
        sessionExternalId: buf.sessionExternalId,
        messageExternalId: messageId,
        content: buf.content,
        role: buf.role,
        isFinal,
        sequenceNum: buf.sequenceNum,
        parts: partsArray.length > 0 ? partsArray : undefined,
      })
    } catch (err) {
      console.warn('[sse-bridge] flush failed:', (err as Error).message)
    }
    if (isFinal) this.buffers.delete(messageId)
  }

  private async flushAll(): Promise<void> {
    for (const [msgId] of this.buffers) {
      await this.flushMessage(msgId, false)
    }
  }
}
