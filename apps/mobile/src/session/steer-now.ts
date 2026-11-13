import { createContext, useContext } from 'react'

/**
 * Sends a steered message without waiting for the agent's current step, by
 * its id in the chat's queue: the environment stops the step and runs the
 * message next. Rejects with the environment's reason.
 */
export type SendSteerNow = (queueItemId: string) => Promise<void>

/**
 * The page's Send now, for the steered rows in its transcript. A context, so
 * a row reads a function that never changes rather than the thread state,
 * which changes with every token. Null where the environment cannot (or on
 * a sample session): the rows then only say what they wait for.
 */
export const SteerNowContext = createContext<SendSteerNow | null>(null)

export const useSendSteerNow = () => useContext(SteerNowContext)
