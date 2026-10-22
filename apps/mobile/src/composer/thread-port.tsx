import { memo, useLayoutEffect, useState, useSyncExternalStore } from 'react'
import {
  useActiveThreadState,
  type ActiveThreadStateValue,
  type SendRefused,
  type UploadedImageAttachment,
} from '@openmanager/app-core/logic'

type ThreadCommands = Pick<ActiveThreadStateValue, 'sendMessage' | 'abortSession' | 'buildPlan'>

/**
 * The thread's commands and its listed status, for the composer. The shared
 * thread state is a new value with every streamed token (its rows change),
 * so the composer does not read it: `ThreadBridge` does, renders nothing,
 * and hands on only the status, and only when it changes. The commands are
 * read at the moment they run, so the latest is always the one called.
 */
export interface ThreadPort {
  status(): string | undefined
  subscribe(listener: () => void): () => void
  /** Rejects when the environment refused the message, with its reason. */
  send(text: string, attachments?: UploadedImageAttachment[]): Promise<void>
  abort(sessionId: string): Promise<void>
  buildPlan(sessionId: string, requestId: string, modeId?: string): Promise<void>
  /** The bridge's side: what the thread state says now. */
  update(status: string | undefined, commands: ThreadCommands): void
}

export function createThreadPort(): ThreadPort {
  let status: string | undefined
  let commands: ThreadCommands | null = null
  const listeners = new Set<() => void>()
  const need = () => {
    if (!commands) throw new Error('The session is still opening.')
    return commands
  }
  return {
    status: () => status,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    // Async, so a thread that is not open yet is a rejection the caller
    // catches, never a throw out of a press handler.
    send: async (text, attachments) => {
      const outcome: void | SendRefused = await need().sendMessage(text, attachments)
      // The phone has no retry on a refused row: the composer puts the draft back.
      if (outcome && 'refused' in outcome) throw new Error(outcome.refused)
    },
    abort: async (sessionId) => need().abortSession(sessionId),
    buildPlan: async (sessionId, requestId, modeId) =>
      need().buildPlan(sessionId, requestId, modeId),
    update(next, nextCommands) {
      commands = nextCommands
      if (next === status) return
      status = next
      for (const listener of [...listeners]) listener()
    },
  }
}

/** Keeps `port` current with the shared thread state; renders nothing. */
export const ThreadBridge = memo(function ThreadBridge({ port }: { port: ThreadPort }) {
  const thread = useActiveThreadState()
  const status = thread.activeThread?.status
  useLayoutEffect(() => {
    port.update(status, thread)
  })
  return null
})

/** A port and the status it carries, re-rendering only when the status changes. */
export function useThreadPort() {
  const [port] = useState(createThreadPort)
  const status = useSyncExternalStore(port.subscribe, port.status, port.status)
  return { port, status }
}
