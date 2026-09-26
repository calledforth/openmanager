import { typographyBody } from '../../lib/typography'

/** The floating card the composer rests on (fluid.css §3b, Linear's palette
 * surface): no outline, a hairline of shadow and a short drop. It is filled
 * with the user-message colour, so what you type and what you sent match. It wraps the
 * whole stack, so a question card or the todo list attached on top shares
 * one card instead of each drawing an edge. */
export const composerFrame =
  'flex w-full flex-col rounded-[10px] bg-[var(--basis-chat-composer-bg,var(--basis-chat-user-bg))] shadow-float-rest'

/** Composer shell only — sent user bubbles use `userMessageStyles`. It sits on
 * `composerFrame` and draws no surface of its own. */
export const chatInputShell = 'flex w-full flex-col gap-0.5 rounded-[10px] p-1'

/** A popup opened from the composer (model, mode, slash commands, settings):
 * the same floating surface, a notch tighter at the corners. */
export const composerPopover = 'rounded-[8px] bg-float shadow-float'

/** A toolbar control in the composer, after Linear's property chips: bare text
 * at rest, a soft fill under the pointer or while its menu is open. */
export const composerChip =
  'flex h-6 shrink-0 items-center rounded-md px-1.5 text-11-regular leading-none text-[var(--basis-text)] transition-colors duration-100 hover:bg-hover disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent'

export const chatStreamInner = `px-2 py-1 ${typographyBody} text-[var(--basis-text)]`

export const chatComposerTextarea = `thin-scrollbar min-h-[38px] w-full resize-none overflow-y-hidden bg-transparent px-2 py-1 chat-user font-sans text-[var(--basis-text)] placeholder:text-[color-mix(in_srgb,var(--basis-text)_45%,transparent)] focus:outline-none disabled:opacity-50`

export const btnSend =
  'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--basis-action-bg)] text-[var(--basis-action-fg)] transition-colors hover:bg-[var(--basis-action-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--basis-border)] disabled:pointer-events-none disabled:opacity-40'

export const COMPOSER_TEXTAREA_MIN_PX = 38
export const COMPOSER_TEXTAREA_MAX_PX = 156
