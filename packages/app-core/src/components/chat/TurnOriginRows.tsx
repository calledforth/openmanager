import { useCallback, useState } from 'react'
import { ArrowBendDownRightIcon, CaretRightIcon, FlowArrowIcon } from '@phosphor-icons/react'
import type { EnvironmentState } from '@openmanager/environment-client'
import { cn } from '../../lib/utils'
import {
  useEnvironmentClientOptional,
  useEnvironmentState,
} from '../../providers/environment-client'
import { useViewActions } from '../../providers/view-actions'
import { Markdown } from '../markdown/Markdown'
import { ProviderIcon } from '../providers/ProviderIcon'
import type { ProviderIconId } from '../providers/providerIconId'
import { providerName } from '../parts/subagent-card'

/** Who handed a subagent its work: the parent session's agent. */
export interface DelegatingAgent {
  providerId: string
  /** The parent session's title, when it has one. */
  sessionTitle?: string
  /** Open the parent session. Absent when the host cannot. */
  onOpen?: () => void
}

/** Past this many characters a prompt starts folded; the parent's briefs run long. */
const FOLD_AT = 600

/**
 * The prompt a parent agent gave its subagent, at the top of the child's
 * turn. Not a bubble on the right, since nobody here typed it: a caption that
 * says who asked, over the brief itself on a quiet fill, folded when long.
 */
export function DelegatedPrompt({ content, from }: { content: string; from?: DelegatingAgent }) {
  const long = content.length > FOLD_AT
  const [open, setOpen] = useState(!long)
  const name = from ? providerName(from.providerId) : 'the parent agent'
  return (
    <div className="flex w-full flex-col gap-1.5 pt-6 pb-1" data-turn-origin="delegated">
      <div className="flex min-w-0 items-center gap-1.5 px-1 text-ui-sm text-[var(--basis-text-faint)]">
        {from ? (
          <ProviderIcon providerId={from.providerId as ProviderIconId} className="size-3" />
        ) : (
          <ArrowBendDownRightIcon size={12} aria-hidden />
        )}
        <span className="shrink-0 text-[var(--basis-text-muted)]">Prompt from {name}</span>
        {from?.sessionTitle ? (
          <>
            <span aria-hidden>·</span>
            {from.onOpen ? (
              <button
                type="button"
                onClick={from.onOpen}
                className="min-w-0 cursor-pointer truncate rounded underline-offset-2 transition-colors hover:text-[var(--basis-text)] hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
              >
                {from.sessionTitle}
              </button>
            ) : (
              <span className="min-w-0 truncate">{from.sessionTitle}</span>
            )}
          </>
        ) : null}
      </div>
      <div className="relative rounded-[10px] bg-[var(--basis-surface)] px-3.5 py-2.5">
        <div
          className={cn(
            'chat-user min-w-0 font-sans text-[var(--basis-text)]',
            !open && 'max-h-[9.5rem] overflow-hidden',
          )}
          style={
            open
              ? undefined
              : {
                  maskImage: 'linear-gradient(to bottom, black 55%, transparent)',
                  WebkitMaskImage: 'linear-gradient(to bottom, black 55%, transparent)',
                }
          }
        >
          <Markdown>{content}</Markdown>
        </div>
        {long ? (
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            className="mt-1 cursor-pointer rounded text-ui-sm text-[var(--basis-text-faint)] transition-colors hover:text-[var(--basis-text)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
          >
            {open ? 'Show less' : 'Show the whole prompt'}
          </button>
        ) : null}
      </div>
    </div>
  )
}

/** The summary line of a "subagents finished" notice: its first line, without a trailing colon. */
export function subagentsNoticeLine(content: string): { title: string; more: boolean } {
  // The environment wraps the notice in a tag the agent reads; it says nothing to a person.
  const lines = content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !/^<\/?[a-z-]+>$/.test(line))
  const first = (lines[0] ?? 'Subagents finished').replace(/[:.]\s*$/, '')
  return { title: first, more: lines.length > 1 }
}

/**
 * The environment telling the agent its subagents finished. Nobody typed it,
 * so it reads as an event in the timeline, one quiet line, which opens to what
 * the agent was told.
 */
export function SubagentsFinishedNotice({ content }: { content: string }) {
  const [open, setOpen] = useState(false)
  const { title, more } = subagentsNoticeLine(content)
  return (
    <div className="flex w-full flex-col pt-6 pb-1" data-turn-origin="subagents">
      <button
        type="button"
        aria-expanded={more ? open : undefined}
        disabled={!more}
        onClick={() => setOpen((value) => !value)}
        className="group/notice flex min-w-0 max-w-full cursor-pointer items-center gap-1.5 self-start rounded-md px-1 py-0.5 text-left text-ui-md text-[var(--basis-text-muted)] transition-colors hover:text-[var(--basis-text)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:hover:text-[var(--basis-text-muted)]"
      >
        <FlowArrowIcon
          size={13}
          aria-hidden
          className="shrink-0"
          style={{ color: 'var(--basis-status-done)' }}
        />
        <span className="min-w-0 truncate">{title}</span>
        {more ? (
          <CaretRightIcon
            size={10}
            aria-hidden
            className={cn(
              'shrink-0 text-[var(--basis-text-faint)] transition-transform duration-150',
              open && 'rotate-90',
            )}
          />
        ) : null}
      </button>
      {open ? (
        <div className="custom-scrollbar mt-1 max-h-[320px] overflow-y-auto rounded-[10px] bg-[var(--basis-surface)] px-3 py-2 text-ui-sm whitespace-pre-wrap break-words text-[var(--basis-text-muted)]">
          {content}
        </div>
      ) : null}
    </div>
  )
}

/** The delegated prompt of the open child session, with its parent named from the environment. */
export function DelegatedPromptRow({ content }: { content: string }) {
  const client = useEnvironmentClientOptional()
  return client ? (
    <ConnectedDelegatedPrompt content={content} />
  ) : (
    <DelegatedPrompt content={content} />
  )
}

function ConnectedDelegatedPrompt({ content }: { content: string }) {
  const { openChildSession } = useViewActions()
  const parent = useEnvironmentState(
    useCallback((state: EnvironmentState) => {
      const child = state.activeSessionId ? state.sessions[state.activeSessionId] : undefined
      return child?.parentSessionId ? state.sessions[child.parentSessionId] : undefined
    }, []),
  )
  const from: DelegatingAgent | undefined = parent
    ? {
        providerId: parent.providerId,
        ...(parent.title ? { sessionTitle: parent.title } : {}),
        ...(openChildSession
          ? {
              onOpen: () =>
                void openChildSession(parent.sessionId, parent.sessionId).catch(() => undefined),
            }
          : {}),
      }
    : undefined
  return <DelegatedPrompt content={content} from={from} />
}
