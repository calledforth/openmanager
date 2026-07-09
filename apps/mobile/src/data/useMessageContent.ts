import { api } from '@openmanager/convex/_generated/api'
import { useQuery } from 'convex/react'

// Finalized message body. Gated exactly as the desktop `ResolvedMessage`:
// only fetch when the message is final or is a user message, and never for
// optimistic (client-only) ids.

export interface MessageContent {
  externalId: string
  content: string
  metadata?: { parts?: unknown; runtime?: unknown }
  isFinal?: boolean
  role: string
}

export function useMessageContent(params: {
  externalId: string
  role: string
  isFinal?: boolean
  isOptimistic?: boolean
}): MessageContent | null {
  const enabled = !params.isOptimistic && (params.isFinal === true || params.role === 'user')

  const content = useQuery(
    api.messages.getContent,
    enabled ? { externalId: params.externalId } : 'skip',
  )

  return (content ?? null) as MessageContent | null
}
