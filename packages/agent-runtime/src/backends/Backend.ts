import type { AgentEvent } from '@agentpack/contract'

/** Where an event goes. A session runtime owns exactly one thread, so this is
 * fixed for its whole life apart from the `create_session` rebind. */
export type BackendRoute = { threadId: string; workspaceId?: string }
export type BackendEvent = Omit<AgentEvent, 'id' | 'seq' | 'timestamp' | 'providerId'>
export type BackendEventListener = (event: BackendEvent) => void
export type SessionResult = {
  sessionId: string
  state: 'created' | 'loaded' | 'reused'
  resumeCursor?: string
}
