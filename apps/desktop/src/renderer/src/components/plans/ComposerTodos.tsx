import { useEffect, useState } from 'react'
import type { PlanEntry } from '@agentpack/contract'
import { useActiveSession } from '../../providers/active-session-provider'
export { ComposerTodos } from '@openmanager/app-core/components/plans/ComposerTodos'

function readPlanEntries(parts: Array<{ type: string; [key: string]: unknown }> | undefined) {
  const plan = parts?.find((part) => part.type === 'plan')
  if (!plan || !Array.isArray(plan.entries)) return null
  return plan.entries as PlanEntry[]
}

/** Latest ACP plan checklist for the active session (live + hydrated turns). */
export function useSessionPlanEntries(): PlanEntry[] {
  const { activeSessionId, messages, streamingStore } = useActiveSession()
  const [entries, setEntries] = useState<PlanEntry[]>([])

  useEffect(() => {
    setEntries([])
  }, [activeSessionId])

  useEffect(() => {
    if (!activeSessionId) return
    return window.electronAPI.onStreamToken((event) => {
      if (event.sessionId !== activeSessionId) return
      if (event.event !== 'plan_update') return
      setEntries(event.data.entries ?? [])
    })
  }, [activeSessionId])

  useEffect(() => {
    if (!activeSessionId) return
    const assistantIds = messages
      .filter((message) => message.role === 'assistant')
      .map((message) => message.externalId)
      .slice(-8)

    const pullLatest = () => {
      for (let index = assistantIds.length - 1; index >= 0; index -= 1) {
        const snapshot = streamingStore.get(assistantIds[index]!)
        const next = readPlanEntries(snapshot?.parts)
        if (next && next.length > 0) {
          setEntries(next)
          return
        }
      }
    }

    const unsubs = assistantIds.map((id) => {
      streamingStore.ensureHydrated(id)
      return streamingStore.subscribe(id, pullLatest)
    })
    pullLatest()
    return () => unsubs.forEach((unsubscribe) => unsubscribe())
  }, [activeSessionId, messages, streamingStore])

  return entries
}
