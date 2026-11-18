import { z } from 'zod'
import { EntityIdSchema, TimestampSchema } from './domains.js'
import { utf8Length } from './flow.js'
import { CommandEnvelopeSchema, EventEnvelopeSchema, ResponseEnvelopeSchema } from './envelopes.js'

/**
 * A project's scratchpad: one markdown file the user keeps notes in, at
 * `SCRATCHPAD_PATH` under the project's root, so the project's agents can
 * read it with their own file tools. The environment reads and writes the
 * file, watches it while a client has it open, and tells those clients when
 * it changes, whoever changed it. "No project" has none.
 *
 * Additive: each command is a capability a client checks before asking, and
 * `scratchpad.changed` is a current reading sent only to connections that
 * asked for that scratchpad, never a stored event. So it needs no protocol
 * or event format version of its own.
 */
export const SCRATCHPAD_GET_CAPABILITY = 'scratchpad.get' as const
export const SCRATCHPAD_SAVE_CAPABILITY = 'scratchpad.save' as const
export const SCRATCHPAD_SHARING_SET_CAPABILITY = 'scratchpad.sharing.set' as const
/**
 * The scratchpad as it is now, sent to every connection that read it with
 * `scratchpad.get`, whenever its text or its sharing changes. Not history: it
 * has no cursor and is not replayed, so a client that reconnects reads it
 * again.
 */
export const SCRATCHPAD_CHANGED_EVENT = 'scratchpad.changed' as const

/** Where the file lives, relative to the project's root. Agents are told this path. */
export const SCRATCHPAD_PATH = '.openmanager/scratchpad.md'

/**
 * The largest scratchpad, in UTF-8 bytes: what one `scratchpad.save` can
 * carry under the environment's 64 KiB message limit, with room for the
 * envelope. A file grown past it outside the panel is reported `tooLarge`
 * and its text is not sent.
 */
export const SCRATCHPAD_MAX_BYTES = 60_000

/**
 * Who made the last change, as the receiving connection reads it: `you` is
 * this client, `client` another paired device, `agent` a session whose tool
 * call wrote the file just before it changed, and `external` anything else
 * (an editor, a script, or an agent the environment could not tell apart).
 */
export const ScratchpadAuthorSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('you') }),
  z.strictObject({ kind: z.literal('client'), clientId: EntityIdSchema }),
  z.strictObject({
    kind: z.literal('agent'),
    sessionId: EntityIdSchema,
    providerId: EntityIdSchema,
  }),
  z.strictObject({ kind: z.literal('external') }),
])

export const ScratchpadEditSchema = z.strictObject({
  by: ScratchpadAuthorSchema,
  at: TimestampSchema,
})

export const ScratchpadSchema = z.strictObject({
  workspaceId: EntityIdSchema,
  /** Whether the file exists. A scratchpad nobody has written reads as empty. */
  exists: z.boolean(),
  /** The file's text; empty when it does not exist or is `tooLarge`. */
  content: z.string(),
  /** The file is larger than `SCRATCHPAD_MAX_BYTES`; `content` is empty. */
  tooLarge: z.boolean(),
  /**
   * Names this exact content (a hash), null while there is no file. A save
   * names the version it was edited from, and is refused if the file moved.
   */
  version: z.string().min(1).max(128).nullable(),
  /** The file's modification time. */
  modifiedAt: TimestampSchema.nullable(),
  /**
   * The last change the environment saw happen, null when it has not seen
   * one since it started (it does not remember who wrote a file before).
   */
  lastEdit: ScratchpadEditSchema.nullable(),
  /**
   * Whether agents in this project are told the scratchpad exists. On by
   * default; the file itself is in the project either way.
   */
  shareWithAgents: z.boolean(),
})

const command = <N extends string, P extends z.ZodType>(name: N, payload: P) =>
  CommandEnvelopeSchema.extend({ name: z.literal(name), payload })
const response = <P extends z.ZodType>(payload: P) => ResponseEnvelopeSchema.extend({ payload })

export const ScratchpadCommandSchemas = {
  /**
   * Read a project's scratchpad, and hear `scratchpad.changed` for it on
   * this connection from now on. Fails with `validation` for "No project".
   */
  [SCRATCHPAD_GET_CAPABILITY]: command(
    SCRATCHPAD_GET_CAPABILITY,
    z.strictObject({ workspaceId: EntityIdSchema }),
  ),
  /**
   * Replace the file's text. Written only if the file is still at
   * `baseVersion` (null: there is no file yet); otherwise nothing is written
   * and the answer is `conflict` with the scratchpad as it is now, for the
   * client to merge into and save again. The first save creates the file,
   * and in a git checkout adds `.openmanager/` to `.git/info/exclude`.
   */
  [SCRATCHPAD_SAVE_CAPABILITY]: command(
    SCRATCHPAD_SAVE_CAPABILITY,
    z.strictObject({
      workspaceId: EntityIdSchema,
      content: z.string(),
      baseVersion: z.string().min(1).max(128).nullable(),
    }),
  ),
  /** Turn telling agents about the scratchpad on or off for one project. */
  [SCRATCHPAD_SHARING_SET_CAPABILITY]: command(
    SCRATCHPAD_SHARING_SET_CAPABILITY,
    z.strictObject({ workspaceId: EntityIdSchema, shareWithAgents: z.boolean() }),
  ),
} as const

export const ScratchpadResponseSchemas = {
  [SCRATCHPAD_GET_CAPABILITY]: response(z.strictObject({ scratchpad: ScratchpadSchema })),
  [SCRATCHPAD_SAVE_CAPABILITY]: response(
    z.strictObject({
      outcome: z.enum(['saved', 'conflict']),
      scratchpad: ScratchpadSchema,
    }),
  ),
  [SCRATCHPAD_SHARING_SET_CAPABILITY]: response(z.strictObject({ scratchpad: ScratchpadSchema })),
} as const

export const ScratchpadChangedEventSchema = EventEnvelopeSchema.extend({
  name: z.literal(SCRATCHPAD_CHANGED_EVENT),
  payload: z.strictObject({ scratchpad: ScratchpadSchema }),
})

/** The scratchpad's size as `SCRATCHPAD_MAX_BYTES` counts it. */
export const scratchpadBytes = (text: string): number => utf8Length(text)

export type ScratchpadAuthor = z.infer<typeof ScratchpadAuthorSchema>
export type ScratchpadEditRecord = z.infer<typeof ScratchpadEditSchema>
export type Scratchpad = z.infer<typeof ScratchpadSchema>
export type ScratchpadChangedEvent = z.infer<typeof ScratchpadChangedEventSchema>
export type ScratchpadSaveResult = z.infer<
  (typeof ScratchpadResponseSchemas)[typeof SCRATCHPAD_SAVE_CAPABILITY]
>['payload']
