import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { ArrowLeftIcon, ArrowRightIcon } from '@phosphor-icons/react'
import { typographyCaption, typographyLabel, typographyTitle } from '../../lib/typography'
import { cn } from '../../lib/utils'
import { draftFor, indexForKey, optionKey, summarizeAnswer } from './questionFlow'
import type { QuestionFlow } from './useQuestionFlow'

/* Rows have no fill of their own. A wash of the text colour marks the row the
 * keyboard is on, and a stronger one marks the answer. The negative margin
 * pulls the text back to the card's edge so it lines up with the question,
 * while the wash still extends past it. */
const rowBase =
  'group -mx-2 flex w-[calc(100%+1rem)] items-baseline gap-3 rounded-[6px] px-2 py-1 text-left transition-colors focus:outline-none'
const rowCursor = 'bg-[color-mix(in_srgb,var(--basis-text)_6%,transparent)]'
const rowSelected = 'bg-[color-mix(in_srgb,var(--basis-text)_11%,transparent)]'

const footerButton = `flex items-center gap-1.5 rounded-[5px] ${typographyCaption} text-[var(--basis-text-muted)] transition-colors hover:text-[var(--basis-text-strong)] disabled:pointer-events-none disabled:opacity-40`

/** Descriptions this short read better beside the label than beneath it — the
 * layout follows the content rather than a fixed rule. */
const INLINE_DESCRIPTION_LIMIT = 46

/** Question card. It sits flush on top of the composer, which doubles as this
 * card's free-text field — see `MessageInput`. */
export function QuestionCard({ flow }: { flow: QuestionFlow }) {
  const { questions, index, drafts, question, onReview, lastIndex } = flow
  const shellRef = useRef<HTMLDivElement>(null)
  const draft = question ? draftFor(drafts, question.questionId) : undefined
  // -1 means "nothing highlighted". A slide must open with no row singled out,
  // or the first option reads as already chosen.
  const [cursor, setCursor] = useState(-1)

  // The card itself takes focus, not a row, so the arrow keys work the moment a
  // question appears without anything looking selected.
  useEffect(() => {
    setCursor(-1)
    shellRef.current?.focus({ preventScroll: true })
  }, [index])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      flow.skip()
      return
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault()
      flow.goTo(index + 1)
      return
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      flow.goTo(index - 1)
      return
    }
    const options = question?.options ?? []
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!options.length) return
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      setCursor((current) =>
        current === -1
          ? step === 1
            ? 0
            : options.length - 1
          : (current + step + options.length) % options.length,
      )
      return
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      // Enter takes the highlighted row first and only then moves on, so
      // arrowing to an option and pressing Enter picks it rather than skipping
      // past it.
      const highlighted = question && cursor >= 0 ? options[cursor] : undefined
      if (highlighted && !draft?.selectedOptionIds.includes(highlighted.optionId)) {
        flow.pick(question!, highlighted.optionId)
        return
      }
      if (flow.canAdvance) flow.advance()
      return
    }
    if (event.key === ' ' && question && cursor >= 0 && options[cursor]) {
      event.preventDefault()
      flow.pick(question, options[cursor].optionId)
      return
    }
    const byNumber = options[indexForKey(event.key)]
    if (byNumber && question) {
      event.preventDefault()
      flow.pick(question, byNumber.optionId)
    }
  }

  return (
    <div
      ref={shellRef}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      role="group"
      aria-label="Agent question"
      className="flex flex-col gap-2.5 overflow-hidden rounded-t-[var(--basis-chat-shell-radius)] border border-b-0 border-[var(--basis-border)] bg-[var(--basis-surface)] px-3.5 py-3 focus:outline-none"
    >
      <div
        key={index}
        className="question-animate-slide flex flex-col gap-2"
        style={{ '--question-slide-from': `${flow.direction * 8}px` } as React.CSSProperties}
      >
        <div className="flex flex-col gap-0.5">
          <span className={`${typographyCaption} text-[var(--basis-text-muted)]`}>
            {onReview ? 'Review answers' : `Question ${index + 1} of ${questions.length}`}
          </span>
          {question ? (
            <span className={`${typographyTitle} text-[var(--basis-text-strong)]`}>
              {question.prompt}
            </span>
          ) : null}
        </div>

        {onReview ? (
          <div className="flex flex-col">
            {questions.map((item, position) => {
              const summary = summarizeAnswer(item, draftFor(drafts, item.questionId))
              return (
                <button
                  key={item.questionId}
                  type="button"
                  tabIndex={-1}
                  onClick={() => flow.goTo(position)}
                  className={cn(
                    rowBase,
                    'flex-col items-start gap-0.5 hover:bg-[color-mix(in_srgb,var(--basis-text)_6%,transparent)]',
                  )}
                >
                  <span className={`${typographyCaption} text-[var(--basis-text-muted)]`}>
                    {item.prompt}
                  </span>
                  <span
                    className={cn(
                      typographyLabel,
                      summary
                        ? 'text-[var(--basis-text-strong)]'
                        : 'text-[var(--basis-text-faint)]',
                    )}
                  >
                    {summary ?? 'Not answered yet'}
                  </span>
                </button>
              )
            })}
          </div>
        ) : question ? (
          <div className="flex flex-col">
            {question.options.map((option, position) => {
              const selected = draft!.selectedOptionIds.includes(option.optionId)
              const key = optionKey(position)
              const description = option.description ?? ''
              const inline =
                description.length > 0 && description.length <= INLINE_DESCRIPTION_LIMIT
              return (
                <button
                  key={option.optionId}
                  type="button"
                  tabIndex={-1}
                  role={question.allowMultiple ? 'checkbox' : 'radio'}
                  aria-checked={selected}
                  onMouseEnter={() => setCursor(position)}
                  onClick={() => flow.pick(question, option.optionId)}
                  className={cn(rowBase, cursor === position && rowCursor, selected && rowSelected)}
                >
                  <span
                    className={cn('min-w-0 flex-1', inline ? 'block' : 'flex flex-col gap-0.5')}
                  >
                    <span
                      className={cn(
                        typographyLabel,
                        'text-[var(--basis-text-strong)]',
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
                    /* The badge is the only place multi-select is announced: a
                     * box you can fill, versus a bare number you cannot. */
                    <span
                      className={cn(
                        typographyCaption,
                        'flex h-[17px] shrink-0 items-center justify-center transition-colors',
                        question.allowMultiple
                          ? 'w-[17px] rounded-[5px] border'
                          : 'w-[17px] justify-end',
                        question.allowMultiple && selected
                          ? 'border-[var(--basis-text-strong)] bg-[var(--basis-text-strong)] text-[var(--basis-canvas-bg)]'
                          : question.allowMultiple
                            ? 'border-[var(--basis-border-strong)] text-[var(--basis-text-faint)]'
                            : selected
                              ? 'text-[var(--basis-text-strong)]'
                              : 'text-[var(--basis-text-faint)]',
                      )}
                    >
                      {key}
                    </span>
                  ) : null}
                </button>
              )
            })}
          </div>
        ) : null}
      </div>

      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          tabIndex={-1}
          onClick={() => flow.goTo(index - 1)}
          disabled={index === 0}
          className={cn(footerButton, index === 0 && 'invisible')}
        >
          <ArrowLeftIcon size={11} weight="regular" />
          Back
        </button>
        {/* One control on the right, whatever the slide needs: leaving without
         * answering is a skip, and answering turns it into the way forward. */}
        {flow.canAdvance ? (
          <button
            type="button"
            tabIndex={-1}
            onClick={flow.advance}
            className={`${footerButton} text-[var(--basis-text-strong)]`}
          >
            {index === lastIndex ? (flow.submitting ? 'Sending…' : 'Submit') : 'Next'}
            <ArrowRightIcon size={11} weight="regular" />
          </button>
        ) : (
          <button type="button" tabIndex={-1} onClick={flow.skip} className={footerButton}>
            Skip
            <ArrowRightIcon size={11} weight="regular" />
          </button>
        )}
      </div>
    </div>
  )
}
