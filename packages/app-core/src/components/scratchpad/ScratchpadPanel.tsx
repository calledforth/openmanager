import { useMemo, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { CheckIcon, FolderSimpleIcon, NotePencilIcon, SparkleIcon } from '@phosphor-icons/react'
import { cn } from '../../lib/utils'
import { useNow } from '../../lib/relative-time'
import { spring } from '../fluid/lib/springs'
import { Switch } from '../fluid/ui/switch'
import { Tooltip } from '../fluid/ui/tooltip'
import { Markdown } from '../markdown/Markdown'
import { ago } from '../pull-requests/pull-request-status'
import { Kbd } from '../side-panel/Kbd'
import { PanelSubheader, usePanelKeys } from '../side-panel/PanelDeck'
import { diffLines, diffStat } from './line-diff'

/**
 * Who changed it: you (on any of your devices), an agent, or something the
 * environment could not name (an editor, a script), shown as "elsewhere".
 */
export type ScratchpadAuthor =
  { kind: 'you' } | { kind: 'agent'; name: string } | { kind: 'external' }

export interface ScratchpadEdit {
  by: ScratchpadAuthor
  /** ISO time. */
  at: string
}

export interface ScratchpadPanelProps {
  /** The project the scratchpad belongs to. */
  projectName: string
  content: string
  /** Every keystroke; the owner saves (debounced) and reports `saveState`. */
  onChange: (content: string) => void
  lastEdit: ScratchpadEdit | null
  /**
   * Edits someone else made that you have not looked at: the text before
   * them, and the last of them. Null once seen.
   */
  unseen: (ScratchpadEdit & { before: string }) | null
  onMarkSeen: () => void
  /** Whether agents in the project are told it exists. */
  shareWithAgents: boolean
  onShareWithAgentsChange: (next: boolean) => void
  saveState?: 'saved' | 'saving' | 'error'
  className?: string
}

type Mode = 'read' | 'edit' | 'changes'

/**
 * The project's scratchpad: one markdown page you and the project's agents
 * share. It reads as rendered markdown; E (or a double-click) edits the
 * source in place, Esc leaves. When someone else has changed it since you last
 * looked, a line at the top says who and how much, and D shows the change as
 * a diff.
 */
export function ScratchpadPanel({
  projectName,
  content,
  onChange,
  lastEdit,
  unseen,
  onMarkSeen,
  shareWithAgents,
  onShareWithAgentsChange,
  saveState = 'saved',
  className,
}: ScratchpadPanelProps) {
  const reduceMotion = useReducedMotion()
  const [mode, setMode] = useState<Mode>('read')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const empty = content.trim() === ''

  const startEditing = () => {
    setMode('edit')
    requestAnimationFrame(() => {
      const area = textareaRef.current
      if (!area) return
      area.focus()
      area.setSelectionRange(area.value.length, area.value.length)
    })
  }
  const closeChanges = () => {
    onMarkSeen()
    setMode('read')
  }

  usePanelKeys((event) => {
    const key = event.key.toLowerCase()
    if (mode === 'changes') {
      // Enter marks the edit read; Esc (or D again) goes back and keeps it unread.
      if (event.key === 'Enter') {
        closeChanges()
        return true
      }
      if (event.key === 'Escape' || key === 'd') {
        setMode('read')
        return true
      }
      return false
    }
    if (key === 'e' || (event.key === 'Enter' && mode === 'read')) {
      startEditing()
      return true
    }
    if (key === 'd' && unseen) {
      setMode('changes')
      return true
    }
    return false
  })

  return (
    <div className={cn('flex h-full min-h-0 min-w-0 flex-col', className)}>
      <PanelSubheader
        title="Scratchpad"
        meta={
          <>
            <FolderSimpleIcon size={12} aria-hidden className="shrink-0" />
            <span className="truncate">{projectName}</span>
          </>
        }
      >
        {empty && mode === 'read' ? null : (
          <ModeToggle
            mode={mode === 'changes' && !unseen ? 'read' : mode}
            changes={unseen !== null}
            onRead={() => {
              textareaRef.current?.blur()
              setMode('read')
            }}
            onEdit={startEditing}
            onChanges={() => setMode('changes')}
          />
        )}
      </PanelSubheader>

      <AnimatePresence initial={false}>
        {unseen && mode !== 'changes' ? (
          <motion.div
            key="unseen"
            initial={reduceMotion ? false : { opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0, transition: spring.moderate.exit }}
            transition={reduceMotion ? { duration: 0 } : spring.moderate}
            className="shrink-0 overflow-hidden"
          >
            <UnseenNotice
              edit={unseen}
              stat={diffStat(diffLines(unseen.before, content))}
              onReview={() => setMode('changes')}
              onDismiss={onMarkSeen}
            />
          </motion.div>
        ) : null}
      </AnimatePresence>

      <div className="relative min-h-0 flex-1">
        {mode === 'changes' && unseen ? (
          <ChangesView
            before={unseen.before}
            after={content}
            edit={unseen}
            onMarkRead={closeChanges}
          />
        ) : mode === 'edit' ? (
          <textarea
            ref={textareaRef}
            value={content}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key === 'Escape' ||
                (event.key === 'Enter' && (event.metaKey || event.ctrlKey))
              ) {
                event.preventDefault()
                event.currentTarget.blur()
                setMode('read')
              }
            }}
            spellCheck
            aria-label={`Scratchpad for ${projectName}`}
            placeholder={'# Plan\n\n- [ ] First thing\n\nNotes, decisions, links…'}
            className={cn(
              // A sheet set into the panel says "you are editing": the text
              // keeps the read view's left edge (8 + 8 = 16px).
              'custom-scrollbar absolute inset-x-2 top-0 bottom-2 block resize-none overflow-y-auto rounded-lg px-2 pt-2 pb-8',
              'bg-hover ring-1 ring-[var(--basis-border-muted)] focus:ring-[var(--basis-border)]',
              'font-sans text-[13px] leading-[1.65] text-[var(--basis-text)] outline-none',
              'placeholder:text-[var(--basis-text-faint)] caret-[var(--basis-accent-blue)]',
            )}
          />
        ) : empty ? (
          <EmptyState projectName={projectName} onStart={startEditing} />
        ) : (
          <div
            onDoubleClick={startEditing}
            className="custom-scrollbar absolute inset-0 overflow-y-auto overscroll-contain px-4 pt-2 pb-8"
          >
            <Markdown className="scratchpad-md text-[13px] leading-[1.65] [&_h1]:text-[16px] [&_h2]:text-[14px] [&_h3]:text-[13px]">
              {content}
            </Markdown>
          </div>
        )}
      </div>

      <Footer
        shareWithAgents={shareWithAgents}
        onShareWithAgentsChange={onShareWithAgentsChange}
        // The banner already says who edited last; an empty page has no history worth showing.
        lastEdit={unseen || empty ? null : lastEdit}
        editing={mode === 'edit'}
        saveState={saveState}
        projectName={projectName}
      />
    </div>
  )
}

// ─── Pieces ─────────────────────────────────────────────────────────────────

type ToggleMode = 'read' | 'edit' | 'changes'

function ModeToggle({
  mode,
  changes,
  onRead,
  onEdit,
  onChanges,
}: {
  mode: ToggleMode
  /** Offer the Changes segment: there is an edit by someone else you have not read. */
  changes: boolean
  onRead: () => void
  onEdit: () => void
  onChanges: () => void
}) {
  const reduceMotion = useReducedMotion()
  const options: { id: ToggleMode; label: string; key: string; onSelect: () => void }[] = [
    { id: 'read', label: 'Read', key: 'Esc', onSelect: onRead },
    { id: 'edit', label: 'Edit', key: 'E', onSelect: onEdit },
    ...(changes
      ? [{ id: 'changes' as const, label: 'Changes', key: 'D', onSelect: onChanges }]
      : []),
  ]
  return (
    <div
      role="radiogroup"
      aria-label="Mode"
      className="flex h-6 items-center rounded-md bg-hover p-0.5"
    >
      {options.map((option) => {
        const selected = option.id === mode
        return (
          <Tooltip
            key={option.id}
            side="bottom"
            content={
              <span className="flex items-center gap-1.5">
                {option.label} <Kbd inverted>{option.key}</Kbd>
              </span>
            }
          >
            <button
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={option.onSelect}
              className={`text-11-medium ${cn(
                'relative h-5 cursor-pointer rounded-[5px] px-2 leading-none transition-colors duration-150',
                'focus-visible:outline-2 focus-visible:outline-ring',
                selected
                  ? 'text-[var(--basis-text-strong)]'
                  : 'text-[var(--basis-text-muted)] hover:text-[var(--basis-text-strong)]',
              )}`}
            >
              {selected ? (
                <motion.span
                  layoutId="scratchpad-mode"
                  aria-hidden
                  className="absolute inset-0 rounded-[5px] bg-float shadow-float-rest"
                  transition={reduceMotion ? { duration: 0 } : spring.moderate}
                />
              ) : null}
              <span className="relative">{option.label}</span>
            </button>
          </Tooltip>
        )
      })}
    </div>
  )
}

function ChangeStat({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="flex shrink-0 items-center gap-1 text-11-medium tabular-nums">
      {added ? <span style={{ color: 'var(--basis-status-done)' }}>+{added}</span> : null}
      {removed ? <span style={{ color: 'var(--basis-status-error)' }}>−{removed}</span> : null}
    </span>
  )
}

function AuthorName({ by }: { by: ScratchpadAuthor }) {
  if (by.kind === 'you') return <>You</>
  if (by.kind === 'external') return <>Edited elsewhere</>
  return (
    <span className="inline-flex items-center gap-1 align-[-1px]">
      <SparkleIcon
        size={11}
        weight="fill"
        aria-hidden
        style={{ color: 'var(--basis-accent-blue)' }}
      />
      {by.name}
    </span>
  )
}

function UnseenNotice({
  edit,
  stat,
  onReview,
  onDismiss,
}: {
  edit: ScratchpadEdit
  stat: { added: number; removed: number }
  onReview: () => void
  onDismiss: () => void
}) {
  const now = useNow()
  return (
    <div className="px-2 pb-1">
      <div className="flex min-h-8 items-center gap-2 rounded-lg bg-hover py-1 pr-1 pl-2.5">
        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-12-regular text-[var(--basis-text)]">
          <span className="shrink-0 text-12-medium text-[var(--basis-text-strong)]">
            <AuthorName by={edit.by} />
          </span>
          <span className="truncate text-[var(--basis-text-muted)]">
            {/* "Edited elsewhere" already says what happened. */}
            {edit.by.kind === 'external' ? ago(edit.at, now) : `edited ${ago(edit.at, now)}`}
          </span>
          <ChangeStat {...stat} />
        </span>
        <button
          type="button"
          onClick={onDismiss}
          className="h-6 cursor-pointer rounded-md px-2 text-11-medium text-[var(--basis-text-muted)] transition-colors hover:bg-hover hover:text-[var(--basis-text-strong)] focus-visible:outline-2 focus-visible:outline-ring"
        >
          Mark read
        </button>
        <button
          type="button"
          onClick={onReview}
          className="flex h-6 cursor-pointer items-center gap-1.5 rounded-md bg-float px-2 text-11-medium text-[var(--basis-text-strong)] shadow-float-rest transition-colors focus-visible:outline-2 focus-visible:outline-ring"
        >
          Review <Kbd className="h-4 min-w-4 text-[10px]">D</Kbd>
        </button>
      </div>
    </div>
  )
}

/** The unseen change as a unified diff, with the unchanged runs folded. */
function ChangesView({
  before,
  after,
  edit,
  onMarkRead,
}: {
  before: string
  after: string
  edit: ScratchpadEdit
  onMarkRead: () => void
}) {
  const now = useNow()
  const lines = useMemo(() => diffLines(before, after), [before, after])
  const stat = diffStat(lines)
  const blocks = useMemo(() => foldUnchanged(lines, 2), [lines])
  return (
    <div className="absolute inset-0 flex flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 pr-2 pl-4">
        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-12-regular text-[var(--basis-text-muted)]">
          <span className="text-12-medium text-[var(--basis-text-strong)]">
            <AuthorName by={edit.by} />
          </span>
          {ago(edit.at, now)}
          <ChangeStat {...stat} />
        </span>
        <button
          type="button"
          onClick={onMarkRead}
          className="flex h-6 cursor-pointer items-center gap-1.5 rounded-md bg-float pr-1 pl-2 text-11-medium text-[var(--basis-text-strong)] shadow-float-rest focus-visible:outline-2 focus-visible:outline-ring"
        >
          <CheckIcon size={12} weight="bold" aria-hidden />
          Mark read
          <Kbd className="h-4 min-w-4 text-[10px]">↵</Kbd>
        </button>
      </div>
      <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto px-2 pb-8">
        <div className="overflow-hidden rounded-lg font-mono text-[12px] leading-[1.7]">
          {blocks.map((block, index) =>
            block.kind === 'fold' ? (
              <div
                key={`fold-${index}`}
                className="px-3 py-0.5 text-11-regular text-[var(--basis-text-faint)] select-none"
              >
                ⋯ {block.count} unchanged {block.count === 1 ? 'line' : 'lines'}
              </div>
            ) : (
              <div
                key={`line-${index}`}
                className={cn(
                  'flex min-w-0 gap-2 px-2',
                  block.kind === 'added' && 'bg-[var(--basis-status-done-wash)]',
                  block.kind === 'removed' && 'bg-[var(--basis-status-error-wash)]',
                )}
              >
                <span
                  aria-hidden
                  className="w-3 shrink-0 text-center select-none"
                  style={{
                    color:
                      block.kind === 'added'
                        ? 'var(--basis-status-done)'
                        : block.kind === 'removed'
                          ? 'var(--basis-status-error)'
                          : 'transparent',
                  }}
                >
                  {block.kind === 'added' ? '+' : block.kind === 'removed' ? '−' : ' '}
                </span>
                <span
                  className={cn(
                    'min-w-0 flex-1 break-words whitespace-pre-wrap',
                    block.kind === 'same' && 'text-[var(--basis-text-muted)]',
                    block.kind === 'removed' &&
                      'text-[var(--basis-text-muted)] line-through decoration-[var(--basis-status-error)]/40',
                    block.kind === 'added' && 'text-[var(--basis-text-strong)]',
                  )}
                >
                  {block.text || ' '}
                </span>
              </div>
            ),
          )}
        </div>
      </div>
    </div>
  )
}

type Block = { kind: 'same' | 'added' | 'removed'; text: string } | { kind: 'fold'; count: number }

/** Keeps `context` unchanged lines around each change and folds the rest. */
function foldUnchanged(
  lines: readonly { kind: 'same' | 'added' | 'removed'; text: string }[],
  context: number,
): Block[] {
  const keep = lines.map(() => false)
  lines.forEach((line, index) => {
    if (line.kind === 'same') return
    for (
      let k = Math.max(0, index - context);
      k <= Math.min(lines.length - 1, index + context);
      k++
    )
      keep[k] = true
  })
  const out: Block[] = []
  let folded = 0
  lines.forEach((line, index) => {
    if (keep[index]) {
      if (folded) out.push({ kind: 'fold', count: folded })
      folded = 0
      out.push(line)
    } else folded++
  })
  if (folded) out.push({ kind: 'fold', count: folded })
  return out
}

function EmptyState({ projectName, onStart }: { projectName: string; onStart: () => void }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-8 text-center">
      <span className="flex size-10 items-center justify-center rounded-[10px] bg-hover text-[var(--basis-text-muted)]">
        <NotePencilIcon size={18} aria-hidden />
      </span>
      <div className="flex max-w-[260px] flex-col gap-1 text-balance">
        <p className="text-13-medium text-[var(--basis-text-strong)]">
          A notebook for {projectName}
        </p>
        <p className="text-12-regular leading-[1.5] text-[var(--basis-text-muted)]">
          Plans, decisions, links, the things you keep re-explaining. Agents in this project know
          where it is and read it when it&apos;s relevant.
        </p>
      </div>
      <button
        type="button"
        onClick={onStart}
        className="mt-1 flex h-7 cursor-pointer items-center gap-2 rounded-md bg-float pr-1.5 pl-2.5 text-12-medium text-[var(--basis-text-strong)] shadow-float-rest focus-visible:outline-2 focus-visible:outline-ring"
      >
        Start writing <Kbd>E</Kbd>
      </button>
    </div>
  )
}

function Footer({
  shareWithAgents,
  onShareWithAgentsChange,
  lastEdit,
  editing,
  saveState,
  projectName,
}: {
  shareWithAgents: boolean
  onShareWithAgentsChange: (next: boolean) => void
  lastEdit: ScratchpadEdit | null
  editing: boolean
  saveState: 'saved' | 'saving' | 'error'
  projectName: string
}) {
  const now = useNow()
  let status: ReactNode = null
  if (saveState === 'saving') status = 'Saving…'
  else if (saveState === 'error')
    status = <span className="text-[var(--basis-status-error)]">Not saved</span>
  else if (editing)
    status = (
      <>
        <CheckIcon size={11} aria-hidden /> Saved
      </>
    )
  else if (lastEdit)
    status = (
      <>
        <AuthorName by={lastEdit.by} /> · {ago(lastEdit.at, now)}
      </>
    )
  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-t border-[var(--basis-border-muted)] px-3">
      <Tooltip
        side="top"
        content={
          shareWithAgents
            ? `Agents in ${projectName} are told about this page and read it when it’s relevant`
            : `Agents in ${projectName} aren’t told about this page`
        }
      >
        <span className="flex items-center gap-2">
          <Switch
            label="Share with agents"
            checked={shareWithAgents}
            onToggle={() => onShareWithAgentsChange(!shareWithAgents)}
            size="compact"
          />
        </span>
      </Tooltip>
      <span className="flex-1" />
      <span className="flex items-center gap-1 truncate text-11-regular text-[var(--basis-text-faint)]">
        {status}
      </span>
    </div>
  )
}

/** The home row's summary for the scratchpad view. */
export function scratchpadSummary(
  content: string,
  lastEdit: ScratchpadEdit | null,
  now: number,
): ReactNode {
  if (content.trim() === '') return 'Empty — jot something down'
  const firstLine =
    content
      .split('\n')
      .map((line) => line.replace(/^#+\s*|^[-*]\s+(\[.\]\s*)?/g, '').trim())
      .find(Boolean) ?? ''
  if (!lastEdit) return firstLine
  return (
    <>
      <AuthorName by={lastEdit.by} />
      <span className="text-[var(--basis-text-faint)]">·</span>
      <span className="truncate">{ago(lastEdit.at, now)}</span>
    </>
  )
}
