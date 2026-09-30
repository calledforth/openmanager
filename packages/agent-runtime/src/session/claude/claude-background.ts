import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { BackgroundTask, BackgroundTaskKind } from '@agentpack/contract'
import { object, string } from '../wire.js'

/** Background work in Claude Code, as the wire reports it.
 *
 * A turn can end while work it started keeps running: a `Bash` call with
 * `run_in_background`, an `Agent` launched the same way, a `Monitor` loop. When
 * such a task settles the CLI wakes the model by itself, and what follows is a
 * whole turn nobody prompted — `system/init`, assistant output, and a `result`
 * whose `origin` says why it ran. Live-verified on claude 2.1.285:
 *
 *   result  { user_message_uuid: <ours> }                  the user's turn
 *   system/background_tasks_changed { tasks: [] }          the task settled
 *   system/task_notification
 *   system/init
 *   assistant ...                                          nobody asked for this
 *   result  { origin: { kind: 'task-notification' } }      and no user_message_uuid
 *
 * `background_tasks_changed` is the level signal and the only one read here.
 * The `task_started` / `task_notification` edges are not a roster: a subagent's
 * own foreground `Bash` emits `task_started` without ever joining the list, so
 * pairing edges counts work that is not in the background at all. */

/** Bookkeeping tasks that are neither agents nor anything a user started. */
const INERT_TASK_TYPES = new Set(['plan', 'dream'])

function taskKind(taskType: string | undefined): BackgroundTaskKind {
  switch (taskType) {
    case 'local_bash':
    case 'shell':
      return 'shell'
    case 'monitor':
    case 'monitor_mcp':
      return 'monitor'
    case 'local_workflow':
    case 'workflow':
      return 'workflow'
    case 'local_agent':
    case 'remote_agent':
    case 'subagent':
      return 'agent'
    default:
      return 'other'
  }
}

/** The roster a `background_tasks_changed` frame carries, or undefined for any
 * other frame. REPLACE semantics: the payload is every live task. */
export function claudeBackgroundTasks(message: SDKMessage): BackgroundTask[] | undefined {
  if (message.type !== 'system' || message.subtype !== 'background_tasks_changed') return undefined
  const tasks = object(message).tasks
  if (!Array.isArray(tasks)) return []
  return tasks.flatMap((value): BackgroundTask[] => {
    const task = object(value)
    const taskId = string(task.task_id)
    const taskType = string(task.task_type)
    if (!taskId || (taskType && INERT_TASK_TYPES.has(taskType))) return []
    return [{ taskId, kind: taskKind(taskType), description: string(task.description) ?? '' }]
  })
}

/** Did a turn the CLI started by itself end here?
 *
 * `origin` names what a turn was run for, and is absent on a turn the user
 * prompted. Anything that is not a person — a task notification, an
 * auto-continuation, a peer — is a turn nobody is awaiting. */
export function isUnpromptedResult(message: Extract<SDKMessage, { type: 'result' }>): boolean {
  const kind = string(object(object(message).origin).kind)
  return kind !== undefined && kind !== 'human'
}

/** Is this the first frame of top-level assistant output?
 *
 * With no turn in flight, that is a turn the CLI began by itself. Subagent
 * frames never qualify: a background subagent streams long after the turn that
 * launched it has ended, and that is its work, not the main agent speaking. */
export function startsAssistantOutput(message: SDKMessage): boolean {
  if (message.type !== 'assistant' && message.type !== 'stream_event') return false
  if (string(object(message).parent_tool_use_id)) return false
  if (message.type === 'assistant') return true
  return string(object(object(message).event).type) === 'message_start'
}

export function sameBackgroundTasks(
  a: readonly BackgroundTask[],
  b: readonly BackgroundTask[],
): boolean {
  return (
    a.length === b.length &&
    a.every((task, index) => {
      const other = b[index]!
      return (
        task.taskId === other.taskId &&
        task.kind === other.kind &&
        task.description === other.description
      )
    })
  )
}
