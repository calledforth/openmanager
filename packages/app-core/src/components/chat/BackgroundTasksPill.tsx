import { useEffect, useState, type ComponentType } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import {
  BinocularsIcon,
  CaretDownIcon,
  CircleDashedIcon,
  FlowArrowIcon,
  RobotIcon,
  TerminalWindowIcon,
  type IconProps,
} from '@phosphor-icons/react'
import type { BackgroundTask } from '@openmanager/environment-client'
import { cn } from '../../lib/utils'
import { Tooltip } from '../ui/Tooltip'
import {
  useEnvironmentClientOptional,
  useEnvironmentState,
} from '../../providers/environment-client'

const KIND: Record<BackgroundTask['kind'], { icon: ComponentType<IconProps>; label: string }> = {
  agent: { icon: RobotIcon, label: 'Background agent' },
  shell: { icon: TerminalWindowIcon, label: 'Background command' },
  monitor: { icon: BinocularsIcon, label: 'Monitor' },
  workflow: { icon: FlowArrowIcon, label: 'Workflow' },
  other: { icon: CircleDashedIcon, label: 'Background task' },
}

const taskLabel = (task: BackgroundTask) => task.description.trim() || KIND[task.kind].label

const STOP_CLASS =
  'shrink-0 rounded-full px-2 py-0.5 text-11-regular leading-none text-[var(--basis-text-muted)] transition-colors duration-100 hover:bg-hover hover:text-[var(--basis-text)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent disabled:hover:text-[var(--basis-text-muted)]'

/**
 * Work the agent left running after its turn ended, shown just above the
 * composer: a backgrounded command, a subagent, a watch loop. Between turns
 * this is the only sign the session is still busy, and its Stop is the only
 * way to end that work, since the composer's own stop button belongs to a
 * turn.
 *
 * One task reads as its description. Several collapse to a count that opens
 * the list, where each can be stopped by itself.
 */
export function BackgroundTasksPill({
  tasks,
  onStop,
}: {
  tasks: readonly BackgroundTask[]
  /** Stop the tasks named, or all of them. Rejects when the environment refuses. */
  onStop: (taskIds?: string[]) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  /** Tasks asked to stop. "Stopping…" holds until the task leaves the list:
   * the command settling only means the provider was asked. */
  const [stopping, setStopping] = useState<ReadonlySet<string>>(new Set())
  const [failed, setFailed] = useState(false)
  const reduceMotion = useReducedMotion()
  const several = tasks.length > 1

  useEffect(() => {
    if (!several) setOpen(false)
  }, [several])

  if (tasks.length === 0) return null

  const stop = (taskIds?: string[]) => {
    const asked = taskIds ?? tasks.map((task) => task.taskId)
    setFailed(false)
    setStopping((current) => new Set([...current, ...asked]))
    onStop(taskIds).catch(() => {
      setFailed(true)
      setStopping((current) => new Set([...current].filter((taskId) => !asked.includes(taskId))))
    })
  }
  const isStopping = (task: BackgroundTask) => stopping.has(task.taskId)
  const allStopping = tasks.every(isStopping)
  const only = tasks[0]!
  const OnlyIcon = KIND[only.kind].icon
  const summary = several ? `${tasks.length} background tasks` : taskLabel(only)

  return (
    <motion.div
      role="status"
      aria-label={several ? summary : `Running in the background: ${summary}`}
      initial={reduceMotion ? false : { opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: reduceMotion ? 0 : 0.16, ease: [0.22, 1, 0.36, 1] }}
      className="mb-1.5 flex"
    >
      <div
        className={cn(
          'flex min-w-0 max-w-full flex-col bg-float shadow-float-rest',
          open ? 'rounded-[10px]' : 'rounded-full',
        )}
      >
        <AnimatePresence initial={false}>
          {several && open ? (
            <motion.ul
              key="tasks"
              id="background-task-list"
              initial={reduceMotion ? false : { height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: reduceMotion ? 0 : 0.2, ease: [0.22, 1, 0.36, 1] }}
              className="custom-scrollbar flex max-h-[148px] flex-col overflow-y-auto"
            >
              {tasks.map((task, index) => {
                const Icon = KIND[task.kind].icon
                return (
                  <li
                    key={task.taskId}
                    className={cn(
                      'flex items-center gap-1.5 pl-2.5 pr-1',
                      index === 0 ? 'pt-1' : 'pt-px',
                    )}
                  >
                    <Icon
                      className="h-3 w-3 shrink-0 text-[var(--basis-text-faint)]"
                      weight="bold"
                      aria-label={KIND[task.kind].label}
                    />
                    <span className="min-w-0 flex-1 truncate text-11-regular leading-5 text-[var(--basis-text)]">
                      {taskLabel(task)}
                    </span>
                    <button
                      type="button"
                      className={STOP_CLASS}
                      disabled={isStopping(task)}
                      aria-label={`Stop ${taskLabel(task)}`}
                      onClick={() => stop([task.taskId])}
                    >
                      {isStopping(task) ? 'Stopping…' : 'Stop'}
                    </button>
                  </li>
                )
              })}
            </motion.ul>
          ) : null}
        </AnimatePresence>
        <div className="flex h-7 min-w-0 items-center gap-1.5 pl-2.5 pr-1">
          <span
            className="todo-progress-loader shrink-0 text-[var(--basis-text-muted)]"
            aria-hidden="true"
          />
          {several ? (
            <button
              type="button"
              aria-expanded={open}
              aria-controls="background-task-list"
              onClick={() => setOpen((current) => !current)}
              className="flex min-w-0 items-center gap-1 rounded-full text-11-regular leading-none text-[var(--basis-text)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
            >
              <span className="truncate">{summary}</span>
              <CaretDownIcon
                className={cn(
                  'h-3 w-3 shrink-0 text-[var(--basis-text-faint)] transition-transform duration-200',
                  open && 'rotate-180',
                )}
              />
            </button>
          ) : (
            <Tooltip content={KIND[only.kind].label}>
              <span className="flex min-w-0 items-center gap-1.5 text-11-regular leading-none text-[var(--basis-text)]">
                <OnlyIcon
                  className="h-3 w-3 shrink-0 text-[var(--basis-text-faint)]"
                  weight="bold"
                  aria-hidden="true"
                />
                <span className="truncate">{summary}</span>
              </span>
            </Tooltip>
          )}
          {failed ? (
            <span role="alert" className="shrink-0 text-11-regular leading-none text-red-400">
              Couldn’t stop
            </span>
          ) : null}
          <button
            type="button"
            className={STOP_CLASS}
            disabled={allStopping}
            onClick={() => stop()}
          >
            {allStopping ? 'Stopping…' : several ? 'Stop all' : 'Stop'}
          </button>
        </div>
      </div>
    </motion.div>
  )
}

const NO_TASKS: readonly BackgroundTask[] = []

/** The active session's background work, for hosts backed by an environment. */
export function SessionBackgroundTasks() {
  const client = useEnvironmentClientOptional()
  return client ? <EnvironmentBackgroundTasks /> : null
}

function EnvironmentBackgroundTasks() {
  const client = useEnvironmentClientOptional()!
  const sessionId = useEnvironmentState((state) => state.activeSessionId)
  const tasks = useEnvironmentState((state) =>
    state.activeSessionId
      ? (state.sessions[state.activeSessionId]?.backgroundTasks ?? NO_TASKS)
      : NO_TASKS,
  )
  if (!sessionId || tasks.length === 0 || !client.supports('stopBackgroundTasks')) return null
  return (
    <BackgroundTasksPill
      // Per session: a stop pending in one must not show as pending in the next.
      key={sessionId}
      tasks={tasks}
      onStop={(taskIds) =>
        client.commands.stopBackgroundTasks({ sessionId, ...(taskIds ? { taskIds } : {}) })
      }
    />
  )
}
