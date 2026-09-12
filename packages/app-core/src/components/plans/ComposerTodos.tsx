import { useEffect, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { CaretDownIcon, ListChecksIcon } from '@phosphor-icons/react'
import type { PlanEntry, PlanEntryStatus } from '@agentpack/contract'
import { cn } from '../../lib/utils'
import { typographyCaption } from '../../lib/typography'
import { useActiveThreadState } from '../../providers/active-thread-provider'

function readPlanEntries(parts: Array<{ type: string; [key: string]: unknown }> | undefined) {
  const plan = parts?.find((part) => part.type === 'plan')
  if (!plan || !Array.isArray(plan.entries)) return null
  return plan.entries as PlanEntry[]
}

/** Latest ACP plan checklist for the active session, read from the streaming
 * store's `plan` part across the most recent assistant turns (live and
 * hydrated alike). A session another client drives has its unfinished turn
 * in the remote store, so that one is watched as well. */
export function useSessionPlanEntries(): PlanEntry[] {
  const { activeSessionId, activeThreadDriven, messages, streamingStore, remoteStreamingStore } =
    useActiveThreadState()
  const [entries, setEntries] = useState<PlanEntry[]>([])

  useEffect(() => {
    setEntries([])
  }, [activeSessionId])

  useEffect(() => {
    if (!activeSessionId) return
    const assistants = messages.filter((message) => message.role === 'assistant').slice(-8)
    const remote = !activeThreadDriven && remoteStreamingStore ? remoteStreamingStore : null
    const sourcesFor = (message: (typeof assistants)[number]) =>
      remote && message.isFinal !== true ? [streamingStore, remote] : [streamingStore]

    const pullLatest = () => {
      for (let index = assistants.length - 1; index >= 0; index -= 1) {
        const message = assistants[index]!
        for (const source of sourcesFor(message)) {
          // The newest plan part wins, an empty one included: the agent
          // clearing its checklist must not leave the previous list on screen.
          const next = readPlanEntries(source.get(message.externalId)?.parts)
          if (next) {
            setEntries(next)
            return
          }
        }
      }
    }

    const unsubs = assistants.flatMap((message) =>
      sourcesFor(message).map((source) => {
        source.ensureHydrated(message.externalId)
        return source.subscribe(message.externalId, pullLatest)
      }),
    )
    pullLatest()
    return () => unsubs.forEach((unsubscribe) => unsubscribe())
  }, [activeSessionId, activeThreadDriven, messages, remoteStreamingStore, streamingStore])

  return entries
}

function TodoStatusIcon({ status }: { status: PlanEntryStatus }) {
  if (status === 'completed') {
    return (
      <svg viewBox="0 0 16 16" className="h-3 w-3 shrink-0 text-[#22c55e]" aria-hidden="true">
        <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.25" />
        <path
          d="M5 8.1l2 2 4.2-4.2"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    )
  }
  if (status === 'in_progress') {
    return (
      <span
        className="todo-progress-loader shrink-0 text-[var(--basis-text)]"
        role="img"
        aria-label="In progress"
      />
    )
  }
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-3 w-3 shrink-0 text-[var(--basis-text-faint)]"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.25" />
    </svg>
  )
}

export function ComposerTodos({
  entries,
  defaultOpen = false,
}: {
  entries: PlanEntry[]
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  const reduceMotion = useReducedMotion()

  if (entries.length === 0) return null

  const completed = entries.filter((entry) => entry.status === 'completed').length
  const total = entries.length

  return (
    <div
      className={cn(
        'overflow-hidden rounded-t-[var(--basis-chat-shell-radius)] border border-b-0 border-[var(--basis-border-muted)]',
        'bg-[var(--basis-canvas-bg)]',
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        className={cn(
          'flex w-full items-center justify-between gap-1.5 px-2 py-1 text-left transition-colors',
          'hover:bg-[color-mix(in_srgb,var(--basis-text)_4%,transparent)]',
        )}
      >
        <span className="flex min-w-0 items-center gap-1 text-11-regular leading-none text-[var(--basis-text-muted)]">
          <ListChecksIcon
            className="h-3 w-3 shrink-0 text-[var(--basis-text-faint)]"
            weight="bold"
          />
          <span className="tracking-wide">Todos</span>
          <span className="tabular-nums text-[var(--basis-text-faint)]">
            {completed}/{total}
          </span>
        </span>
        <CaretDownIcon
          className={cn(
            'h-3 w-3 shrink-0 text-[var(--basis-text-faint)] transition-transform duration-200',
            !open && '-rotate-90',
          )}
        />
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="todos-panel"
            initial={reduceMotion ? false : { height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={
              reduceMotion
                ? { duration: 0 }
                : {
                    height: { duration: 0.28, ease: [0.22, 1, 0.36, 1] },
                    opacity: { duration: 0.2, ease: [0.22, 1, 0.36, 1] },
                  }
            }
            className="overflow-hidden border-t border-[var(--basis-border-muted)]"
          >
            <ul className="custom-scrollbar flex max-h-[132px] flex-col overflow-y-auto px-1.5 py-1">
              {entries.map((entry, index) => {
                const emphasized = entry.status === 'in_progress'
                const done = entry.status === 'completed'
                return (
                  <li
                    key={`${entry.content}:${index}`}
                    className={cn(
                      'flex items-start gap-1.5 rounded-sm px-1 py-0.5',
                      emphasized && 'bg-[color-mix(in_srgb,var(--basis-text)_4%,transparent)]',
                    )}
                  >
                    <span className="mt-px flex h-3 w-3 shrink-0 items-center justify-center">
                      <TodoStatusIcon status={entry.status} />
                    </span>
                    <span
                      className={cn(
                        typographyCaption,
                        'min-w-0 flex-1 leading-tight',
                        emphasized && 'text-[var(--basis-text)]',
                        done && 'text-[var(--basis-text-faint)] line-through',
                        !emphasized && !done && 'text-[var(--basis-text-muted)]',
                      )}
                    >
                      {entry.content}
                    </span>
                  </li>
                )
              })}
            </ul>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
