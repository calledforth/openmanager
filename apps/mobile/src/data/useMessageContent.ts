// Inert until messages come from the environment client's thread snapshot.

export interface MessageContent {
  externalId: string
  content: string
  metadata?: { parts?: unknown; runtime?: unknown }
  isFinal?: boolean
  role: string
}

export function useMessageContent(_params: {
  externalId: string
  role: string
  isFinal?: boolean
  isOptimistic?: boolean
}): MessageContent | null {
  return null
}
