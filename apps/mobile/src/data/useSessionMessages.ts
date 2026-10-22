import {
  countUserMessages,
  createOptimisticUserMessage,
  mergeMessages,
  nextOptimisticSequenceNum,
  reconcileOptimisticMessages,
  type MergedMessage,
  type OptimisticUserMessage,
  type PersistedMessageMeta,
} from '@openmanager/shared/lib/optimistic-messages'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

// Port of the desktop `active-session-provider` message merge: overlay
// optimistic user messages on the persisted list, clearing them as the
// persisted user-message count grows. All the ordering/reconciliation logic is
// the pure reducer in `@openmanager/shared/lib/optimistic-messages`.
//
// The persisted list is empty until the chat screen reads its thread from the
// environment client; the optimistic overlay is kept so the screen behaves as
// before.

const EMPTY: PersistedMessageMeta[] = []

export type SessionMessage = MergedMessage

export function useSessionMessages(sessionExternalId: string | null | undefined) {
  const messageList = EMPTY
  const [optimistic, setOptimistic] = useState<OptimisticUserMessage[]>([])
  const userCountRef = useRef<number | null>(null)
  const counterRef = useRef(0)

  // Reset optimistic state whenever the active session changes.
  useEffect(() => {
    userCountRef.current = null
    setOptimistic([])
  }, [sessionExternalId])

  // Clear optimistic messages the backend has now persisted.
  useEffect(() => {
    const persistedUserCount = countUserMessages(messageList)
    const previous = userCountRef.current
    userCountRef.current = persistedUserCount
    if (previous === null) return
    setOptimistic((prev) => reconcileOptimisticMessages(prev, previous, persistedUserCount))
  }, [messageList])

  const addOptimisticMessage = useCallback(
    (content: string): string | null => {
      const trimmed = content.trim()
      if (!trimmed) return null
      const externalId = `local-user-${Date.now()}-${counterRef.current++}`
      setOptimistic((prev) => {
        const sequenceNum = nextOptimisticSequenceNum(messageList, prev.length)
        return [...prev, createOptimisticUserMessage(externalId, trimmed, sequenceNum)]
      })
      return externalId
    },
    [messageList],
  )

  const removeOptimisticMessage = useCallback((externalId: string) => {
    setOptimistic((prev) => prev.filter((message) => message.externalId !== externalId))
  }, [])

  const messages = useMemo<SessionMessage[]>(
    () => mergeMessages(messageList, optimistic),
    [messageList, optimistic],
  )

  return {
    messages,
    isLoading: false,
    addOptimisticMessage,
    removeOptimisticMessage,
  }
}
