// Inert until the chat screen reads sessions from the environment client.

export interface SessionDetail {
  externalId: string
  workspacePath: string
  title?: string
  status: string
  clientId?: string
}

export function useSession(_externalId: string | null | undefined): {
  session: SessionDetail | null
  isReachable: boolean
  isLoading: boolean
} {
  return { session: null, isReachable: false, isLoading: false }
}
