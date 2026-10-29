import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { ArrowElbowDownLeftIcon, CheckIcon } from '@phosphor-icons/react'
import { typographyCaption, typographyLabel, typographyTitle } from '../../lib/typography'
import { cn } from '../../lib/utils'
import { draftFor, indexForKey, isAnswered, optionKey } from './questionFlow'
import type { QuestionFlow } from './useQuestionFlow'

/* Only the row under the cursor (mouse or keyboard) is shaded; a choice is
 * shown by its box. Chosen rows never fill themselves, so selections can never
 * stack into a slab. */
const rowBase =
  '-mx-2 flex w-[calc(100%+1rem)] items-start gap-2.5 rounded-[6px] px-2 py-[5px] text-left transition-colors duration-100 focus:outline-none'
const rowCursor = 'bg-[color-mix(in_srgb,var(--basis-text)_7%,transparent)]'

/** Descriptions this short read better beside the label than beneath it — the
 * layout follows the content rather than a fixed rule. */
const INLINE_DESCRIPTION_LIMIT = 46

function ChoiceMark({ multiple, selected }: { multiple: boolean; selected: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'flex size-[14px] shrink-0 items-center justify-center border transition-colors duration-100',
        multiple ? 'rounded-[4px]' : 'rounded-full',
        selected
          ? multiple
            ? 'border-[var(--basis-text-strong)] bg-[var(--basis-text-strong)] text-[var(--basis-canvas-bg)]'
            : 'border-[var(--basis-text-strong)]'
          : 'border-[var(--basis-border-strong)]',
      )}
    >
      {selected ? (
        multiple ? (
          <CheckIcon size={10} weight="bold" />
        ) : (
          <span className="size-[6px] rounded-full bg-[var(--basis-text-strong)]" />
        )
      ) : null}
    </span>
  )
}

/** Where the set stands: answered steps filled, the current one a wider ink
 * pill, the rest hollow. Each is a jump target; ←/→ walk them too. */
function StepDots({ flow }: { flow: QuestionFlow }) {
  const { questions, index, drafts } = flow
  return (
    <div className="-mr-1 flex shrink-0 items-center" role="tablist" aria-label="Questions">
      {questions.map((item, position) => {
        const current = position === index
        const answered = isAnswered(item, draftFor(drafts, item.questionId))
        return (
          <button
            key={item.questionId}
            type="button"
            role="tab"
            tabIndex={-1}
            aria-selected={current}
            aria-label={`Question ${position + 1}${answered ? ', answered' : ''}`}
            title={item.prompt}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => flow.goTo(position)}
            className="group flex h-4 items-center px-[3px]"
          >
            <span
              className={cn(
                'block h-[6px] rounded-full transition-all duration-150',
                current
                  ? 'w-[14px] bg-[var(--basis-text-strong)]'
                  : answered
                    ? 'w-[6px] bg-[var(--basis-text-muted)] group-hover:bg-[var(--basis-text)]'
                    : 'w-[6px] border border-[var(--basis-border-strong)] group-hover:border-[var(--basis-text-muted)]',
              )}
            />
          </button>
        )
      })}
    </div>
  )
}

/** Question card. It sits flush on top of the composer, which doubles as this
 * card's free-text field — see `MessageInput`.
 *
 * Keys: ↑/↓ move between options (and on to the Next button), Enter or Space
 * picks — a single choice moves straight on, a multiple choice toggles —
 * 1–9 pick by number, ←/→ change question, ⌘/Ctrl+Enter moves on from
 * anywhere, Esc dismisses the whole set. */
export function QuestionCard({ flow }: { flow: QuestionFlow }) {
  const { questions, index, drafts, question } = flow
  const shellRef = useRef<HTMLDivElement>(null)
  const draft = draftFor(drafts, question.questionId)
  const options = question.options
  const multiple = !!question.allowMultiple
  // -1 means "nothing highlighted": a slide must open with no row singled out,
  // or the first option reads as already chosen. `options.length` is the Next
  // button, reachable by arrowing past the last option once it is enabled.
  const [cursor, setCursor] = useState(-1)
  const primaryStop = options.length
  const stops = options.length + (flow.canAdvance ? 1 : 0)

  // The card itself takes focus, not a row, so the arrow keys work the moment a
  // question appears without anything looking selected.
  useEffect(() => {
    setCursor(-1)
    shellRef.current?.focus({ preventScroll: true })
  }, [index])

  // Answering a multi-select question opens the Next stop; un-answering it
  // closes it again, so the cursor must not be left parked on it.
  useEffect(() => {
    if (!flow.canAdvance) setCursor((current) => (current === primaryStop ? -1 : current))
  }, [flow.canAdvance, primaryStop])

  const pickAt = (position: number) => {
    const option = options[position]
    if (option) flow.choose(question, option.optionId)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const mod = event.metaKey || event.ctrlKey
    if (event.altKey) return
    switch (event.key) {
      case 'Escape':
        event.preventDefault()
        flow.skip()
        return
      case 'ArrowLeft':
      case 'ArrowRight':
        if (mod) return
        event.preventDefault()
        flow.goTo(index + (event.key === 'ArrowRight' ? 1 : -1))
        return
      case 'ArrowDown':
      case 'ArrowUp': {
        if (mod || stops === 0) return
        event.preventDefault()
        const step = event.key === 'ArrowDown' ? 1 : -1
        setCursor((current) =>
          current === -1 ? (step === 1 ? 0 : stops - 1) : (current + step + stops) % stops,
        )
        return
      }
      case 'Home':
      case 'End':
        if (stops === 0) return
        event.preventDefault()
        setCursor(event.key === 'Home' ? 0 : stops - 1)
        return
      case 'Enter':
      case ' ': {
        if (event.key === ' ' && mod) return
        event.preventDefault()
        if (event.repeat) return
        if (mod || cursor === -1 || cursor === primaryStop) {
          // Space with nothing highlighted has nothing to act on.
          if (event.key === 'Enter' || cursor === primaryStop) flow.advance()
          return
        }
        pickAt(cursor)
        return
      }
    }
    if (mod) return
    const byNumber = indexForKey(event.key)
    if (byNumber >= 0 && byNumber < options.length) {
      event.preventDefault()
      setCursor(byNumber)
      pickAt(byNumber)
    }
  }

  const primaryLabel = flow.willSubmit ? (flow.submitting ? 'Sending…' : 'Submit') : 'Next'

  return (
    <div
      ref={shellRef}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      role="group"
      aria-label={
        questions.length > 1
          ? `Agent question ${index + 1} of ${questions.length}`
          : 'Agent question'
      }
      className="flex flex-col gap-2.5 overflow-hidden rounded-t-[10px] px-3.5 pt-3 pb-2.5 focus:outline-none"
    >
      <div
        key={index}
        className="question-animate-slide flex flex-col gap-2"
        style={{ '--question-slide-from': `${flow.direction * 8}px` } as React.CSSProperties}
      >
        <div className="flex items-start gap-3">
          <span className={`${typographyTitle} min-w-0 flex-1 text-[var(--basis-text-strong)]`}>
            {question.prompt}
          </span>
          {questions.length > 1 ? <StepDots flow={flow} /> : null}
        </div>

        <div
          role={multiple ? 'group' : 'radiogroup'}
          aria-label={question.prompt}
          className="flex flex-col gap-px"
          onMouseLeave={() => setCursor((current) => (current === primaryStop ? current : -1))}
        >
          {options.map((option, position) => {
            const selected = draft.selectedOptionIds.includes(option.optionId)
            const key = optionKey(position)
            const description = option.description ?? ''
            const inline = description.length > 0 && description.length <= INLINE_DESCRIPTION_LIMIT
            return (
              <button
                key={option.optionId}
                type="button"
                tabIndex={-1}
                role={multiple ? 'checkbox' : 'radio'}
                aria-checked={selected}
                data-cursor={cursor === position || undefined}
                // Keep focus on the card, so the keys keep working after a click.
                onMouseDown={(event) => {
                  event.preventDefault()
                  shellRef.current?.focus({ preventScroll: true })
                }}
                onMouseMove={() => setCursor(position)}
                onClick={() => pickAt(position)}
                className={cn(rowBase, cursor === position && rowCursor)}
              >
                {/* Mark and digit sit in a label-height line box, so they align
                 * with the title even when the description wraps beneath it. */}
                <span className={cn(typographyLabel, 'flex h-[1lh] shrink-0 items-center')}>
                  <ChoiceMark multiple={multiple} selected={selected} />
                </span>
                <span className={cn('min-w-0 flex-1', inline ? 'block' : 'flex flex-col gap-0.5')}>
                  <span
                    className={cn(
                      typographyLabel,
                      'transition-colors duration-100',
                      selected ? 'text-[var(--basis-text-strong)]' : 'text-[var(--basis-text)]',
                      inline && 'mr-2',
                    )}
                  >
                    {option.label || option.optionId}
                  </span>
                  {description ? (
                    <span className={`${typographyCaption} text-[var(--basis-text-muted)]`}>
                      {description}
                    </span>
                  ) : null}
                </span>
                {key ? (
                  <span
                    aria-hidden
                    className={cn(
                      typographyLabel,
                      'flex h-[1lh] w-3 shrink-0 items-center justify-end font-normal text-ui-xs text-[var(--basis-text-faint)] tabular-nums',
                    )}
                  >
                    {key}
                  </span>
                ) : null}
              </button>
            )
          })}
        </div>
      </div>

      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          tabIndex={-1}
          onMouseDown={(event) => event.preventDefault()}
          onClick={flow.skip}
          className={`${typographyCaption} rounded-[5px] text-[var(--basis-text-faint)] transition-colors hover:text-[var(--basis-text-muted)]`}
        >
          Dismiss
        </button>
        <button
          type="button"
          tabIndex={-1}
          disabled={!flow.canAdvance}
          data-cursor={cursor === primaryStop || undefined}
          onMouseDown={(event) => {
            event.preventDefault()
            shellRef.current?.focus({ preventScroll: true })
          }}
          onClick={flow.advance}
          className={cn(
            typographyCaption,
            'flex h-[22px] items-center gap-1 rounded-[6px] pr-1.5 pl-2 font-medium transition-colors duration-100',
            flow.canAdvance
              ? 'bg-[color-mix(in_srgb,var(--basis-text)_10%,transparent)] text-[var(--basis-text-strong)] hover:bg-[color-mix(in_srgb,var(--basis-text)_16%,transparent)]'
              : 'bg-[color-mix(in_srgb,var(--basis-text)_5%,transparent)] text-[var(--basis-text-faint)]',
            cursor === primaryStop &&
              'outline-1 outline-offset-2 outline-[color-mix(in_srgb,var(--basis-text)_45%,transparent)]',
          )}
        >
          {primaryLabel}
          <ArrowElbowDownLeftIcon size={11} weight="bold" aria-hidden />
        </button>
      </div>
    </div>
  )
}
