import { z } from 'zod'
import { CommandEnvelopeSchema, ResponseEnvelopeSchema } from './envelopes.js'
import { EntityIdSchema, TimestampSchema } from './domains.js'
import { WorkspaceComposerPreferenceSchema } from './composer.js'

export const DRAFT_LIST_CAPABILITY = 'draft.list' as const
export const DRAFT_SAVE_CAPABILITY = 'draft.save' as const
export const DRAFT_DELETE_CAPABILITY = 'draft.delete' as const

const command = <N extends string, P extends z.ZodType>(name: N, payload: P) =>
  CommandEnvelopeSchema.extend({ name: z.literal(name), payload })
const response = <P extends z.ZodType>(payload: P) => ResponseEnvelopeSchema.extend({ payload })

/**
 * The largest `draft.save` a client sends, encoded, leaving room for the
 * envelope under the environment's 64 KiB message limit. A bigger draft is
 * kept on the device that has it until it is short enough to save.
 */
export const DRAFT_SAVE_MAX_BYTES = 60_000
/**
 * A draft's text: anything one message to the environment can carry, so a
 * failed send's first message is always put back whole. Clients still only
 * save what fits in `DRAFT_SAVE_MAX_BYTES`.
 */
export const DRAFT_TEXT_MAX_LENGTH = 65_536
export const DRAFT_ARTIFACTS_MAX = 10

/** UTF-8 length of `text`, counted by hand so every runtime (and lib) can use it. */
function utf8Length(text: string): number {
  let bytes = 0
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4
        i += 1
      } else {
        bytes += 3
      }
    } else bytes += 3
  }
  return bytes
}

/** The encoded size of a `draft.save` payload, to check against `DRAFT_SAVE_MAX_BYTES`. */
export const draftSaveBytes = (input: unknown): number => utf8Length(JSON.stringify(input))

/**
 * What a draft holds. Only what the user did: picks the composer seeded from
 * the workspace's "last used" are resolved again when the draft is shown, so
 * a pick that is here was made explicitly and follows the draft.
 */
export const DraftContentSchema = z.strictObject({
  text: z.string().max(DRAFT_TEXT_MAX_LENGTH),
  /** The provider picked for a new-session draft. */
  providerId: EntityIdSchema.optional(),
  /** Model, mode and settings picked for a new-session draft. */
  preference: WorkspaceComposerPreferenceSchema.optional(),
  /** Images uploaded for the draft, in the order they were attached. */
  artifactIds: z.array(EntityIdSchema).max(DRAFT_ARTIFACTS_MAX).optional(),
})

/**
 * Which composer a draft belongs to.
 *
 * - `session`: an existing session's composer. Its draft id is the session id,
 *   so every device writes the same record and a session never has two.
 * - `new_session`: a draft that has not been sent yet. `sessionId` is minted
 *   with the draft and is the id the session gets when the draft is sent, so a
 *   retried first send creates the same session. `workspaceId` is null once the
 *   draft's project has been removed; the draft is kept.
 */
export const DraftTargetSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('session'), sessionId: EntityIdSchema }),
  z.strictObject({
    type: z.literal('new_session'),
    workspaceId: EntityIdSchema.nullable(),
    sessionId: EntityIdSchema,
  }),
])

export const DraftSchema = z.strictObject({
  draftId: EntityIdSchema,
  target: DraftTargetSchema,
  content: DraftContentSchema,
  /** Increases with every save and delete; a save names the one it was based on. */
  revision: z.number().int().positive(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  /** The paired client that wrote this revision, when it is still paired. */
  updatedByClientId: EntityIdSchema.nullable(),
})

/**
 * A session draft that was sent or cleared. A save based on an older revision
 * is refused, so a late save from before the send cannot bring the text back;
 * a save based on this one starts the session's next draft.
 */
export const DraftTombstoneSchema = z.strictObject({
  draftId: EntityIdSchema,
  revision: z.number().int().positive(),
})

/**
 * Composer drafts the environment keeps for every paired client. Writes are
 * last-write-wins: a save is kept whatever revision it was based on, except
 * that a draft that was sent or deleted is never brought back by a save based
 * on a revision from before that.
 */
export const DraftCommandSchemas = {
  [DRAFT_LIST_CAPABILITY]: command(DRAFT_LIST_CAPABILITY, z.null()),
  [DRAFT_SAVE_CAPABILITY]: command(
    DRAFT_SAVE_CAPABILITY,
    z.strictObject({
      /** Minted by the client for a new-session draft; the session id for a session draft. */
      draftId: EntityIdSchema,
      /** The revision this content was edited from, 0 for a draft never saved. */
      baseRevision: z.number().int().nonnegative(),
      target: DraftTargetSchema,
      content: DraftContentSchema,
    }),
  ),
  [DRAFT_DELETE_CAPABILITY]: command(
    DRAFT_DELETE_CAPABILITY,
    z.strictObject({
      draftId: EntityIdSchema,
      /**
       * The revision this client cleared, 0 for a draft it never saw saved.
       * Refused like a save when it is from before the draft's last deletion:
       * a stale clear must not take the draft written since.
       */
      baseRevision: z.number().int().nonnegative(),
      /**
       * Delete only the draft as it is at exactly this revision (0: never
       * saved). Refused with `DRAFT_CHANGED_MESSAGE` when the draft has any
       * other revision: a later one written since, or a lower one after the
       * draft was deleted and written anew under a pruned tombstone. So a
       * discard never takes text another client wrote. Absent: delete whatever
       * the draft holds now, as a clear or a send does.
       */
      ifRevision: z.number().int().nonnegative().optional(),
    }),
  ),
} as const

export const DraftResponseSchemas = {
  [DRAFT_LIST_CAPABILITY]: response(
    z.strictObject({
      drafts: z.array(DraftSchema),
      /** Cleared session drafts, so a client knows which revision to save on top of. */
      tombstones: z.array(DraftTombstoneSchema),
    }),
  ),
  [DRAFT_SAVE_CAPABILITY]: response(z.strictObject({ draft: DraftSchema })),
  [DRAFT_DELETE_CAPABILITY]: response(DraftTombstoneSchema),
} as const

/** The error `draft.save` answers with when the draft was sent or deleted since its base. */
export const DRAFT_DELETED_MESSAGE = 'This draft was sent or deleted.'

export const DraftDeletedDetailsSchema = z.strictObject({
  draftId: EntityIdSchema,
  revision: z.number().int().positive(),
})

/** The error `draft.delete` answers with when `ifRevision` is not the draft's revision now. */
export const DRAFT_CHANGED_MESSAGE = 'This draft was changed since.'

/** Tells a refused conditional delete from `DraftDeletedDetails`, which is strict and has no `changed`. */
export const DraftChangedDetailsSchema = z.strictObject({
  draftId: EntityIdSchema,
  /** The draft's revision now, other than the one the delete named. */
  revision: z.number().int().positive(),
  changed: z.literal(true),
})

export type DraftContent = z.infer<typeof DraftContentSchema>
export type DraftTarget = z.infer<typeof DraftTargetSchema>
export type Draft = z.infer<typeof DraftSchema>
export type DraftTombstone = z.infer<typeof DraftTombstoneSchema>
export type DraftDeletedDetails = z.infer<typeof DraftDeletedDetailsSchema>
export type DraftChangedDetails = z.infer<typeof DraftChangedDetailsSchema>
export type DraftSaveInput = z.infer<
  (typeof DraftCommandSchemas)[typeof DRAFT_SAVE_CAPABILITY]
>['payload']
export type DraftDeleteInput = z.infer<
  (typeof DraftCommandSchemas)[typeof DRAFT_DELETE_CAPABILITY]
>['payload']
export type DraftList = z.infer<
  (typeof DraftResponseSchemas)[typeof DRAFT_LIST_CAPABILITY]
>['payload']
