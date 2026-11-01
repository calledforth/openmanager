import { useCallback, useEffect, useState } from 'react'
import type { ToolOutputTarget } from '@openmanager/environment-client'
import { useEnvironmentClientOptional } from '../providers/environment-client'

export type ToolOutputRead =
  { state: 'idle' } | { state: 'loading' } | { state: 'ready'; text: string } | { state: 'failed' }

/**
 * A settled tool's output, read when its row is opened. The text never changes
 * once a tool has settled, so nothing here can disagree with the environment,
 * and it is held only while the row is open: this is view state, and the store
 * and the browser's cache never see it.
 */
export function useToolOutput(target: ToolOutputTarget | undefined): {
  read: ToolOutputRead
  retry: () => void
} {
  const client = useEnvironmentClientOptional()
  const [attempt, setAttempt] = useState(0)
  const [read, setRead] = useState<ToolOutputRead>({ state: 'idle' })
  const sessionId = target?.sessionId
  const toolCallId = target?.toolCallId

  useEffect(() => {
    if (!sessionId || !toolCallId) {
      setRead({ state: 'idle' })
      return
    }
    if (!client?.fetchToolOutput) {
      setRead({ state: 'failed' })
      return
    }
    const controller = new AbortController()
    setRead({ state: 'loading' })
    client.fetchToolOutput({ sessionId, toolCallId }, { signal: controller.signal }).then(
      (text) => {
        if (!controller.signal.aborted) setRead({ state: 'ready', text })
      },
      () => {
        if (!controller.signal.aborted) setRead({ state: 'failed' })
      },
    )
    return () => controller.abort()
  }, [client, sessionId, toolCallId, attempt])

  return { read, retry: useCallback(() => setAttempt((count) => count + 1), []) }
}
