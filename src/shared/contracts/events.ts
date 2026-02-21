export type EventType =
  | 'message.part.updated'
  | 'message.updated'
  | 'session.updated'
  | 'session.deleted'
  | 'permission.requested'
  | 'permission.resolved'

export interface EventEnvelope<T = unknown> {
  id: string
  type: EventType
  sessionId: string
  timestamp: number
  data: T
  sequenceNum?: number
}

export interface MessagePartEvent {
  messageId: string
  content: string
  role: string
  isFinal: boolean
}

export interface SessionStatusEvent {
  sessionId: string
  status: string
  previousStatus?: string
}

export interface PermissionRequestEvent {
  permissionId: string
  sessionId: string
  toolName: string
  description: string
  args?: Record<string, unknown>
}
