export interface Workspace {
  id: string
  name: string
  path: string
  machineId: string
  createdAt: number
  updatedAt: number
}

export interface Session {
  id: string
  workspaceId: string
  externalId: string
  title?: string
  status: SessionStatus
  createdAt: number
  updatedAt: number
}

export type SessionStatus = 'idle' | 'running' | 'waiting' | 'done' | 'error'

export interface Message {
  id: string
  sessionId: string
  externalId: string
  role: MessageRole
  content: string
  metadata?: Record<string, unknown>
  createdAt: number
  sequenceNum: number
}

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool'

export interface PendingJob {
  id: string
  workspaceId: string
  sessionId?: string
  type: JobType
  payload: string
  status: JobStatus
  attempts: number
  lastError?: string
  claimedBy?: string
  createdAt: number
  updatedAt: number
}

export type JobType = 'send_message' | 'create_session' | 'abort'
export type JobStatus = 'pending' | 'running' | 'done' | 'failed'

export interface WorkspaceRepository {
  create(workspace: Omit<Workspace, 'id'>): Promise<Workspace>
  getById(id: string): Promise<Workspace | null>
  getByPath(path: string): Promise<Workspace | null>
  list(): Promise<Workspace[]>
  update(id: string, data: Partial<Workspace>): Promise<Workspace>
  remove(id: string): Promise<void>
}

export interface SessionRepository {
  create(session: Omit<Session, 'id'>): Promise<Session>
  getById(id: string): Promise<Session | null>
  getByExternalId(externalId: string): Promise<Session | null>
  listByWorkspace(workspaceId: string): Promise<Session[]>
  update(id: string, data: Partial<Session>): Promise<Session>
  remove(id: string): Promise<void>
}

export interface MessageRepository {
  create(message: Omit<Message, 'id'>): Promise<Message>
  getByExternalId(externalId: string): Promise<Message | null>
  listBySession(sessionId: string): Promise<Message[]>
  getLatestSequenceNum(sessionId: string): Promise<number>
}
