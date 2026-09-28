import { EARLIER_CONTENT_OMITTED, limitTitleMessage } from './prompts.ts'

/** One message of a session as the title model reads it. Reasoning and tool
 * calls are not messages: they are working notes, dwarf the answer they
 * precede, and would make titles both worse and costlier. */
export type TitleContextMessage = {
  role: 'user' | 'assistant'
  text: string
  /** Names of files attached to the message. */
  attachments?: readonly string[]
}

const MAX_CONTEXT = 8_000
const MAX_MESSAGE = 2_000
/** Room kept for assistant messages, which resolve what vague prompts meant. */
const ASSISTANT_RESERVE = 2_000
const MAX_ATTACHMENTS = 4

/**
 * Lay a conversation out for renaming within one budget. What the user asked
 * decides a title, so user messages are chosen first (the first one, then the
 * newest), and assistant output can never push them out; assistant messages,
 * newest first, fill what is left. Then any spare room lets the chosen
 * messages grow back toward their full length. Order on the page is always
 * conversation order.
 *
 * Ported from T3 Code's thread titles (MIT).
 */
export function formatTitleContext(messages: readonly TitleContextMessage[]): {
  message: string
  attachments: string[]
} {
  const sections = messages.flatMap((message, index) =>
    message.text.trim() || message.attachments?.length
      ? [{ index, message, prefix: `${message.role.toUpperCase()}:\n` }]
      : [],
  )
  type Section = (typeof sections)[number]
  const newestFirst = [...sections].reverse()
  const contentsOf = (section: Section): string => {
    const names = section.message.attachments?.join(', ')
    return [section.message.text.trim(), ...(names ? [`[Attachments: ${names}]`] : [])]
      .filter(Boolean)
      .join('\n')
  }
  const selected = new Map<number, string>()
  let remaining = MAX_CONTEXT - EARLIER_CONTENT_OMITTED.length
  const add = (section: Section, budget: number): void => {
    if (selected.has(section.index)) return
    const limit = Math.min(budget, remaining) - section.prefix.length - 2
    if (limit <= 0) return
    const contents = limitTitleMessage(contentsOf(section), limit)
    if (!contents) return
    const text = section.prefix + contents
    selected.set(section.index, text)
    remaining -= text.length + 2
  }

  const firstUser = sections.find((section) => section.message.role === 'user')
  if (firstUser) add(firstUser, MAX_MESSAGE)
  for (const section of newestFirst) {
    if (section.message.role === 'user')
      add(section, Math.min(MAX_MESSAGE, remaining - ASSISTANT_RESERVE))
  }
  for (const section of newestFirst) {
    if (section.message.role === 'assistant') add(section, MAX_MESSAGE)
  }
  // Spare room, when the conversation is short: users first, then the agent.
  for (const role of ['user', 'assistant'] as const) {
    for (const section of newestFirst) {
      const previous = selected.get(section.index)
      if (section.message.role !== role || previous === undefined) continue
      const expanded =
        section.prefix +
        limitTitleMessage(contentsOf(section), previous.length + remaining - section.prefix.length)
      if (expanded.length <= previous.length) continue
      remaining -= expanded.length - previous.length
      selected.set(section.index, expanded)
    }
  }

  const retained = sections.filter((section) => selected.has(section.index))
  const cut =
    retained.length < sections.length ||
    retained.some((section) => selected.get(section.index) !== section.prefix + contentsOf(section))
  const firstAttachment = firstUser?.message.attachments?.[0]
  const later = retained
    .flatMap((section) => section.message.attachments ?? [])
    .filter((name) => name !== firstAttachment)
  return {
    message: `${cut ? EARLIER_CONTENT_OMITTED : ''}${retained
      .map((section) => selected.get(section.index))
      .join('\n\n')}`,
    attachments: [
      ...(firstAttachment ? [firstAttachment] : []),
      ...later.slice(-(MAX_ATTACHMENTS - (firstAttachment ? 1 : 0))),
    ],
  }
}
