import { memo, useLayoutEffect, useState, useSyncExternalStore } from 'react'
import {
  useActiveThreadState,
  type ActiveThreadStateValue,
  type FollowUpAction,
  type SendRefused,
  type UploadedImageAttachment,
} from '@openmanager/app-core/logic'

type ThreadCommands = Pick<
  ActiveThreadStateValue,
  'sendMessage' | 'abortSession' | 'buildPlan' | 'followUps'
>

/**
 * What the composer reads of the thread: its listed status, and whether a
 * message sent now waits or joins the running turn. Each changes with the
 * turn, never with a token.
 */
export interface ThreadPortState {
  status: string | undefined
  /** A message sent now cannot start a turn of its own (`followUps.busy`). */
  busy: boolean
  /** The running turn takes a steered message (`followUps.canSteer`). */
  canSteer: boolean
}

const INITIAL: ThreadPortState = { status: undefined, busy: false, canSteer: false }

/**
 * The thread's commands and its state, for the composer. The shared thread
 * state is a new value with every streamed token (its rows change), so the
 * composer does not read it: `ThreadBridge` does, renders nothing, and hands
 * on only `ThreadPortState`, and only when it changes. The commands are read
 * at the moment they run, so the latest is always the one called.
 */
export interface ThreadPort {
  state(): ThreadPortState
  /** The listed status alone, as before follow-ups. */
  status(): string | undefined
  subscribe(listener: () => void): () => void
  /** Rejects when the environment refused the message, with its reason. */
  send(text: string, attachments?: UploadedImageAttachment[]): Promise<void>
  /** Queue the message for the next turn, or steer it into the running one. Rejects with the reason. */
  followUp(
    action: FollowUpAction,
    text: string,
    attachments?: UploadedImageAttachment[],
  ): Promise<void>
  abort(sessionId: string): Promise<void>
  buildPlan(sessionId: string, requestId: string, modeId?: string): Promise<void>
  /** The bridge's side: what the thread state says now. */
  update(status: string | undefined, commands: ThreadCommands): void
}

export function createThreadPort(): ThreadPort {
  let state = INITIAL
  let commands: ThreadCommands | null = null
  const listeners = new Set<() => void>()
  const need = () => {
    if (!commands) throw new Error('The session is still opening.')
    return commands
  }
  return {
    state: () => state,
    status: () => state.status,
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
    followUp: async (action, text, attachments) => {
      const followUps = need().followUps
      if (!followUps) throw new Error('This environment cannot hold a message for later.')
      await followUps[action](text, attachments)
    },
    abort: async (sessionId) => need().abortSession(sessionId),
    buildPlan: async (sessionId, requestId, modeId) =>
      need().buildPlan(sessionId, requestId, modeId),
    update(status, nextCommands) {
      commands = nextCommands
      const busy = nextCommands.followUps?.busy === true
      const canSteer = nextCommands.followUps?.canSteer === true
      if (status === state.status && busy === state.busy && canSteer === state.canSteer) return
      state = { status, busy, canSteer }
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

/** A port and the state it carries, re-rendering only when that state changes. */
export function useThreadPort() {
  const [port] = useState(createThreadPort)
  const state = useSyncExternalStore(port.subscribe, port.state, port.state)
  return { port, status: state.status, busy: state.busy, canSteer: state.canSteer }
}
