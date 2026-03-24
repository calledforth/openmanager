export interface AgentSession {
  id: string
  title?: string
  status?: string
  createdAt?: string
}

export interface AgentClient {
  createSession(title?: string): Promise<AgentSession>
  loadSession?(sessionId: string): Promise<void>
  deleteSession(id: string): Promise<void>
  sendMessageAsync(sessionId: string, content: string): Promise<void>
  abortSession(sessionId: string): Promise<void>
  resolvePermission(sessionId: string, permissionId: string, approved: boolean): Promise<void>
  setSessionModel?(sessionId: string, modelId: string): Promise<void>
  setSessionMode?(sessionId: string, modeId: string): Promise<void>
}
