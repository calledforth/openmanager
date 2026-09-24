import { z } from 'zod'
import { CommandEnvelopeSchema, ResponseEnvelopeSchema } from './envelopes.js'
import { EntityIdSchema } from './domains.js'

export const UPLOAD_TICKET_CAPABILITY = 'upload.ticket.create' as const
/** The ticket is the last path segment: `PUT /uploads/<ticket>`. */
export const UPLOAD_PATH_PREFIX = '/uploads/' as const

/** Stored bytes are read back with `GET /artifacts/<session-id>/<artifact-id>`. */
export const ARTIFACT_PATH_PREFIX = '/artifacts/' as const

/**
 * Where an artifact's bytes live, relative to the environment's HTTP origin.
 * Local and remote clients resolve it against whichever endpoint they reached
 * the environment through, so both end up on the same route.
 */
export const artifactPath = (sessionId: string, artifactId: string) =>
  `${ARTIFACT_PATH_PREFIX}${encodeURIComponent(sessionId)}/${encodeURIComponent(artifactId)}`

const command = <N extends string, P extends z.ZodType>(name: N, payload: P) =>
  CommandEnvelopeSchema.extend({ name: z.literal(name), payload })
const response = <P extends z.ZodType>(payload: P) => ResponseEnvelopeSchema.extend({ payload })

/** A display name only. It never becomes a path on the environment. */
export const UploadNameSchema = z.string().trim().min(1).max(255)
export const UploadMimeTypeSchema = z
  .string()
  .max(255)
  .regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i)
export const UploadSizeSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)

/**
 * File bytes never travel on the WebSocket. A client declares the file on the
 * command channel, receives a short-lived single-use ticket bound to its
 * credential and the session, and PUTs the raw bytes to `uploadPath` over HTTP.
 *
 * A draft has no session yet, so it names its workspace instead. That upload
 * is held for the workspace, owned by the client that sent it, until the
 * `session.create` that launches the draft names it in `artifactIds`.
 */
export const UploadCommandSchemas = {
  [UPLOAD_TICKET_CAPABILITY]: command(
    UPLOAD_TICKET_CAPABILITY,
    z
      .strictObject({
        sessionId: EntityIdSchema.optional(),
        workspaceId: EntityIdSchema.optional(),
        name: UploadNameSchema,
        mimeType: UploadMimeTypeSchema,
        sizeBytes: UploadSizeSchema,
      })
      .refine((upload) => (upload.sessionId === undefined) !== (upload.workspaceId === undefined), {
        message: 'An upload belongs to a session or, for a draft, to a workspace.',
        path: ['sessionId'],
      }),
  ),
} as const

export const UploadResponseSchemas = {
  [UPLOAD_TICKET_CAPABILITY]: response(
    z.strictObject({
      ticket: z.string().min(1).max(256),
      /** Relative to the environment's HTTP origin, so local and remote routes agree. */
      uploadPath: z.string().min(1).max(512),
      expiresAt: z.iso.datetime(),
      maxBytes: UploadSizeSchema,
    }),
  ),
} as const

/**
 * The body of a successful `PUT`. A message references the artifact by this
 * id. No `sessionId` means a draft's upload, held for `workspaceId`.
 */
export const UploadResultSchema = z.strictObject({
  artifactId: EntityIdSchema,
  sessionId: EntityIdSchema.optional(),
  workspaceId: EntityIdSchema,
  name: UploadNameSchema,
  mimeType: UploadMimeTypeSchema,
  sizeBytes: UploadSizeSchema,
})

export type UploadTicket = z.infer<
  (typeof UploadResponseSchemas)[typeof UPLOAD_TICKET_CAPABILITY]
>['payload']
export type UploadResult = z.infer<typeof UploadResultSchema>
