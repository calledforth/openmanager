import { z } from 'zod'
import { EntityIdSchema, TimestampSchema } from './domains.js'
import { CommandEnvelopeSchema, ResponseEnvelopeSchema } from './envelopes.js'

/**
 * Search what was said in this environment's chats. Additive: an environment
 * that does not advertise it is skipped by a client searching several, so it
 * needs no protocol version of its own.
 */
export const SEARCH_MESSAGES_CAPABILITY = 'search.messages' as const

/** The longest query a client sends; the field never needs more. */
export const SEARCH_QUERY_MAX_LENGTH = 256
export const SEARCH_RESULTS_DEFAULT = 20
export const SEARCH_RESULTS_MAX = 50

const command = <N extends string, P extends z.ZodType>(name: N, payload: P) =>
  CommandEnvelopeSchema.extend({ name: z.literal(name), payload })
const response = <P extends z.ZodType>(payload: P) => ResponseEnvelopeSchema.extend({ payload })

/** A run of the snippet that matched, as UTF-16 offsets: `[start, end)`. */
export const SearchHighlightSchema = z
  .tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])
  .refine(([start, end]) => end > start, 'A highlight must not be empty')

/**
 * One session whose messages matched, at the message that matched best.
 * Results come best first; how good is this environment's own measure, so a
 * client merging several environments goes by position, never by score.
 */
export const MessageSearchHitSchema = z.object({
  sessionId: EntityIdSchema,
  workspaceId: EntityIdSchema,
  /** The session's title as the environment holds it now, if it has one. */
  title: z.string().nullable(),
  messageId: EntityIdSchema,
  role: z.enum(['user', 'assistant']),
  /** When the message was written. */
  at: TimestampSchema,
  /** A few words either side of the match, on one line. */
  snippet: z.string().max(2048),
  highlights: z.array(SearchHighlightSchema).max(64),
  /** How many of the session's messages matched, the best one included. */
  matches: z.number().int().positive(),
})

export const SearchCommandSchemas = {
  [SEARCH_MESSAGES_CAPABILITY]: command(
    SEARCH_MESSAGES_CAPABILITY,
    z.object({
      /**
       * Words, as typed. Every word must appear in the message, in any order,
       * as the start of a word there. Case and accents do not matter.
       */
      query: z.string().max(SEARCH_QUERY_MAX_LENGTH),
      limit: z.number().int().min(1).max(SEARCH_RESULTS_MAX).optional(),
    }),
  ),
} as const

export const SearchResponseSchemas = {
  [SEARCH_MESSAGES_CAPABILITY]: response(
    z.object({
      /** Best first, one per session. Empty when nothing matched. */
      hits: z.array(MessageSearchHitSchema).max(SEARCH_RESULTS_MAX),
    }),
  ),
} as const

export type SearchHighlight = z.infer<typeof SearchHighlightSchema>
export type MessageSearchHit = z.infer<typeof MessageSearchHitSchema>
export type MessageSearchResult = z.infer<
  (typeof SearchResponseSchemas)[typeof SEARCH_MESSAGES_CAPABILITY]
>['payload']
