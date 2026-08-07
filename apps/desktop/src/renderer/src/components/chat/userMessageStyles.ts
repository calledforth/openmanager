import { typographyBody } from '../../lib/typography'

/** Sent user-message bubble — intentionally separate from composer `chatInputShell`. */
export const chatUserMessageShell =
  'flex w-full flex-col gap-0.5 rounded-[var(--basis-chat-shell-radius)] border border-[var(--basis-border-muted)] bg-[var(--basis-surface)] p-1'

export const chatUserInner = `px-1 py-0.5 ${typographyBody} text-[var(--basis-text)]`
