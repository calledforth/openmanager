import type { AgentEvent, PermissionOutcome, PromptInput, ProviderId } from '@agentpack/contract'

export type BackendRoute = { threadId: string; workspaceId?: string }
export type BackendSessionArgs = BackendRoute & {
  cwd: string
  sessionId?: string
  resumeCursor?: string
}
export type BackendEvent = Omit<AgentEvent, 'id' | 'seq' | 'timestamp' | 'providerId'>
export type BackendEventListener = (event: BackendEvent) => void
export type SessionResult = {
  sessionId: string
  state: 'created' | 'loaded' | 'reused'
  resumeCursor?: string
}

export interface Backend {
  readonly providerId: ProviderId
  start(args: BackendRoute & { cwd: string }): Promise<void>
  ensureSession(args: BackendSessionArgs): Promise<SessionResult>
  prompt(
    args: BackendRoute & {
      cwd: string
      sessionId: string
      prompt: PromptInput
      userMessageId?: string
    },
  ): Promise<void>
  cancel(args: BackendRoute & { cwd: string; sessionId: string }): Promise<void>
  respondPermission(requestId: string, outcome: PermissionOutcome): boolean
  setModel(args: BackendRoute & { cwd: string; sessionId: string; modelId: string }): Promise<void>
  setMode(args: BackendRoute & { cwd: string; sessionId: string; modeId: string }): Promise<void>
  setConfigOption(
    args: BackendRoute & {
      cwd: string
      sessionId: string
      configId: string
      value: string | boolean
    },
  ): Promise<void>
  events(listener: BackendEventListener): () => void
  dispose(): void
}
