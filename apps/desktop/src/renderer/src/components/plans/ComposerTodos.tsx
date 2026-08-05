import { useEffect, useState } from 'react'
import { CaretDownIcon, ListChecksIcon } from '@phosphor-icons/react'
import type { PlanEntry, PlanEntryStatus } from '@agentpack/contract'
import { cn } from '../../lib/utils'
import { typographyCaption } from '../../lib/typography'
import { useActiveSession } from '../../providers/active-session-provider'

function TodoStatusIcon({ status }: { status: PlanEntryStatus }) {
  if (status === 'completed') {
    return (
      <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0 text-[#22c55e]" aria-hidden="true">
        <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.25" />
        <path
          d="M4.5 8.2l2.2 2.2 4.8-4.8"
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
      <svg
        viewBox="0 0 16 16"
        className="h-3.5 w-3.5 shrink-0 text-[var(--basis-text)]"
        aria-hidden="true"
      >
        <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.25" />
        <circle cx="8" cy="8" r="3.25" fill="currentColor" />
      </svg>
    )
  }
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-3.5 w-3.5 shrink-0 text-[var(--basis-text-faint)]"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.25" />
    </svg>
  )
}

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

export function ComposerTodos({
  entries,
  defaultOpen = false,
}: {
  entries: PlanEntry[]
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)

  if (entries.length === 0) return null

  const completed = entries.filter((entry) => entry.status === 'completed').length
  const total = entries.length

  return (
    <div
      className={cn(
        'overflow-hidden rounded-t-[var(--basis-chat-shell-radius)] border border-b-0 border-[var(--basis-border)]',
        'bg-[color-mix(in_srgb,var(--basis-canvas-bg)_82%,#000)]',
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        className={cn(
          'flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left transition-colors',
          'hover:bg-[color-mix(in_srgb,var(--basis-surface)_55%,transparent)]',
          open && 'border-b border-[var(--basis-border-muted)]',
        )}
      >
        <span className="flex min-w-0 items-center gap-1.5 text-11-regular leading-tight text-[var(--basis-text)]">
          <ListChecksIcon className="h-3.5 w-3.5 shrink-0 text-[var(--basis-text-muted)]" />
          <span>Todos</span>
          <span className="text-[var(--basis-text-muted)]">
            {completed}/{total}
          </span>
        </span>
        <CaretDownIcon
          className={cn(
            'h-3.5 w-3.5 shrink-0 text-[var(--basis-text-faint)] transition-transform duration-200',
            !open && '-rotate-90',
          )}
        />
      </button>

      {open && (
        <ul className="custom-scrollbar flex max-h-[160px] flex-col gap-0.5 overflow-y-auto p-1.5">
          {entries.map((entry, index) => {
            const emphasized = entry.status === 'in_progress'
            const done = entry.status === 'completed'
            return (
              <li
                key={`${entry.content}:${index}`}
                className="flex items-start gap-2 rounded px-1.5 py-1"
              >
                <span className="mt-0.5">
                  <TodoStatusIcon status={entry.status} />
                </span>
                <span
                  className={cn(
                    typographyCaption,
                    'min-w-0 flex-1 leading-snug',
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
      )}
    </div>
  )
}
