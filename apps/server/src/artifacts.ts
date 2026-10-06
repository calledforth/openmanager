import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, statSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { isAllowedUploadType, MAX_ATTACHMENT_BYTES } from './upload-limits.ts'

export type ArtifactMetadata = {
  artifactId: string
  sessionId: string
  workspaceId: string
  name: string
  mimeType: string
  sizeBytes: number
  createdAt: number
  source: 'prompt' | 'generated'
}

/**
 * What an upload records. A draft's upload has no session yet: it is held for
 * its workspace and the client that sent it until `session.create` claims it.
 */
export type RecordedArtifact = Omit<ArtifactMetadata, 'sessionId'> & { sessionId?: string }

/**
 * Who may claim held uploads, and for which new session. A client may claim
 * its own uploads, and any held image in `shared`: the images of the draft
 * being launched, which another device may have attached. The images move to
 * the session's workspace: a draft can be sent from the project it was just
 * moved to before the save that moved it lands.
 */
export type ArtifactClaim = {
  workspaceId: string
  clientId: string
  sessionId: string
  shared?: readonly string[]
}

/** A held image a draft names, as the draft's read route answers it. */
export type HeldArtifactMetadata = Omit<ArtifactMetadata, 'sessionId' | 'workspaceId'> & {
  /** Null once the project it was held for is removed; the draft keeps it. */
  workspaceId: string | null
}

/**
 * Whether a live draft names the attachment row in scope. A draft is the only
 * thing that wants a held image, so this is what keeps one alive.
 */
const NAMED_BY_A_DRAFT = `EXISTS (
  SELECT 1 FROM drafts, json_each(drafts.content_json, '$.artifactIds') AS ref
  WHERE drafts.deleted_at IS NULL AND ref.value = attachments.attachment_id
)`

/** Shared environment-owned metadata and bytes for uploads and provider output. */
export function createArtifactStore(database: DatabaseSync, dataDir: string) {
  const directory = join(dataDir, 'uploads')
  mkdirSync(directory, { recursive: true })
  const lookup = database.prepare(`
    SELECT attachment_id AS artifactId, session_id AS sessionId, workspace_id AS workspaceId,
      name, mime_type AS mimeType, size_bytes AS sizeBytes, created_at AS createdAt, source
    FROM attachments WHERE attachment_id = ? AND session_id = ?
  `)
  const insert = database.prepare(`
    INSERT INTO attachments (attachment_id, session_id, workspace_id, uploaded_by_client_id,
      storage_key, name, mime_type, size_bytes, created_at, source, metadata_json)
    SELECT ?, session_id, workspace_id, ?, ?, ?, ?, ?, ?, ?, ? FROM sessions
      WHERE session_id = ? AND workspace_id = ?
  `)
  const insertHeld = database.prepare(`
    INSERT INTO attachments (attachment_id, session_id, workspace_id, uploaded_by_client_id,
      storage_key, name, mime_type, size_bytes, created_at, source, metadata_json)
    VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  // A held image goes to a session only from the client that uploaded it, or
  // as one of the images of the draft being launched (the last parameter, 1).
  const heldLookup = database.prepare(`
    SELECT 1 FROM attachments WHERE attachment_id = ? AND session_id IS NULL
      AND source = 'prompt' AND (uploaded_by_client_id = ? OR ? = 1)
  `)
  const claimOne = database.prepare(`
    UPDATE attachments SET session_id = ?, workspace_id = ?,
      metadata_json = json_set(COALESCE(metadata_json, '{}'), '$.sessionId', ?)
    WHERE attachment_id = ? AND session_id IS NULL AND source = 'prompt'
      AND (uploaded_by_client_id = ? OR ? = 1)
  `)
  const releaseOne = database.prepare(`
    UPDATE attachments SET session_id = NULL,
      metadata_json = json_remove(COALESCE(metadata_json, '{}'), '$.sessionId')
    WHERE attachment_id = ? AND session_id = ?
  `)
  // Rows migrated with a session they no longer match keep that id in their
  // metadata; only a draft's upload, or one a failed launch handed back, has
  // none. One a saved draft names is still wanted, however old it is.
  const heldBefore = database.prepare(`
    SELECT attachment_id AS artifactId FROM attachments
    WHERE session_id IS NULL AND source = 'prompt'
      AND json_extract(metadata_json, '$.sessionId') IS NULL AND created_at < ?
      AND NOT ${NAMED_BY_A_DRAFT}
  `)
  // Checked again in the delete itself: a draft saved since the read keeps it.
  const deleteHeld = database.prepare(`
    DELETE FROM attachments WHERE attachment_id = ? AND session_id IS NULL
      AND source = 'prompt' AND json_extract(metadata_json, '$.sessionId') IS NULL
      AND NOT ${NAMED_BY_A_DRAFT}
  `)
  const draftImages = database.prepare(`
    SELECT ref.value AS artifactId
    FROM drafts, json_each(drafts.content_json, '$.artifactIds') AS ref
    WHERE drafts.draft_id = ? AND drafts.deleted_at IS NULL
  `)
  const heldForDraft = database.prepare(`
    SELECT attachment_id AS artifactId, workspace_id AS workspaceId, name,
      mime_type AS mimeType, size_bytes AS sizeBytes, created_at AS createdAt, source
    FROM attachments
    WHERE attachment_id = ? AND session_id IS NULL AND source = 'prompt'
      AND EXISTS (
        SELECT 1 FROM drafts, json_each(drafts.content_json, '$.artifactIds') AS ref
        WHERE drafts.draft_id = ? AND drafts.deleted_at IS NULL
          AND ref.value = attachments.attachment_id
      )
  `)
  const get = (sessionId: string, artifactId: string) =>
    lookup.get(artifactId, sessionId) as ArtifactMetadata | undefined
  const path = (artifactId: string) => {
    // Only IDs minted by this store may name files, including after a restart.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(artifactId)) {
      throw new Error('Invalid artifact id')
    }
    return join(directory, artifactId)
  }
  const record = (metadata: RecordedArtifact, clientId?: string) => {
    if (metadata.sessionId === undefined) {
      // The workspace's foreign key refuses a workspace removed mid-transfer.
      insertHeld.run(metadata.artifactId, metadata.workspaceId, clientId ?? null,
        `uploads/${metadata.artifactId}`, metadata.name, metadata.mimeType, metadata.sizeBytes,
        metadata.createdAt, metadata.source, JSON.stringify({ source: metadata.source }))
      return
    }
    const result = insert.run(metadata.artifactId, clientId ?? null,
      `uploads/${metadata.artifactId}`, metadata.name, metadata.mimeType, metadata.sizeBytes,
      metadata.createdAt, metadata.source,
      JSON.stringify({ sessionId: metadata.sessionId, source: metadata.source }),
      metadata.sessionId, metadata.workspaceId)
    if (result.changes !== 1) throw new Error('Artifact session not found')
  }
  const read = (metadata: Pick<ArtifactMetadata, 'artifactId' | 'sizeBytes'>) => {
    const filePath = path(metadata.artifactId)
    const stat = statSync(filePath)
    if (!stat.isFile() || stat.size !== metadata.sizeBytes || stat.size > MAX_ATTACHMENT_BYTES) {
      throw new Error('Artifact size mismatch')
    }
    const bytes = readFileSync(filePath)
    if (bytes.length !== metadata.sizeBytes || bytes.length > MAX_ATTACHMENT_BYTES) {
      throw new Error('Artifact size mismatch')
    }
    return bytes
  }
  const sharedFlag = (artifactId: string, claim: Pick<ArtifactClaim, 'shared'>) =>
    claim.shared?.includes(artifactId) ? 1 : 0
  /** Whether every held upload named here is one this client may give a new session. */
  const claimable = (
    artifactIds: readonly string[],
    claim: Pick<ArtifactClaim, 'clientId' | 'shared'>,
  ) =>
    artifactIds.every(
      (artifactId) =>
        heldLookup.get(artifactId, claim.clientId, sharedFlag(artifactId, claim)) !== undefined,
    )
  /**
   * Hand held uploads to a new session, all or none: a launch that could only
   * take some of its images would send a message the user did not write.
   */
  const claim = (artifactIds: readonly string[], target: ArtifactClaim) => {
    database.exec('BEGIN IMMEDIATE')
    try {
      for (const artifactId of new Set(artifactIds)) {
        const result = claimOne.run(
          target.sessionId,
          target.workspaceId,
          target.sessionId,
          artifactId,
          target.clientId,
          sharedFlag(artifactId, target),
        )
        if (result.changes !== 1) {
          database.exec('ROLLBACK')
          return false
        }
      }
      database.exec('COMMIT')
      return true
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }
  /**
   * Give claimed uploads back to the workspace when the launch that claimed
   * them failed, so a retry can claim them again. Before the session goes:
   * its deletion would take the rows with it.
   */
  const release = (artifactIds: readonly string[], sessionId: string) => {
    for (const artifactId of new Set(artifactIds)) releaseOne.run(artifactId, sessionId)
  }
  const removeBytes = (artifactId: string) => {
    try {
      rmSync(path(artifactId), { force: true })
    } catch {
      // An id this store did not mint names no file; startup sweeps strays.
    }
  }
  /**
   * Remove held uploads no launch claimed before `cutoff` and no saved draft
   * names: the draft was abandoned, or never saved. Row first, then bytes, so
   * a claim racing the sweep either wins the row or finds nothing; it never
   * gets a row whose bytes are gone.
   */
  const expireHeld = (cutoff: number) => {
    const expired: string[] = []
    for (const { artifactId } of heldBefore.all(cutoff) as { artifactId: string }[]) {
      if (deleteHeld.run(artifactId).changes !== 1) continue
      expired.push(artifactId)
      removeBytes(artifactId)
    }
    return expired
  }
  /**
   * Free the held images a deleted draft named, once its deletion is written.
   * One another draft still names, or a session took, stays.
   */
  const discardHeld = (artifactIds: readonly string[]) => {
    const discarded: string[] = []
    for (const artifactId of new Set(artifactIds)) {
      if (deleteHeld.run(artifactId).changes !== 1) continue
      discarded.push(artifactId)
      removeBytes(artifactId)
    }
    return discarded
  }
  /** The images a live draft names, in its order. */
  const imagesOf = (draftId: string) =>
    (draftImages.all(draftId) as { artifactId: unknown }[])
      .map((row) => row.artifactId)
      .filter((artifactId): artifactId is string => typeof artifactId === 'string')
  /** A held image, if the live draft `draftId` names it. */
  const getHeld = (draftId: string, artifactId: string) =>
    heldForDraft.get(artifactId, draftId) as HeldArtifactMetadata | undefined
  return {
    get, record, read, path, claimable, claim, release, expireHeld,
    getHeld,
    discardHeld,
    imagesOf,
    reference(metadata: ArtifactMetadata) {
      return { type: 'artifact' as const, artifactId: metadata.artifactId,
        mimeType: metadata.mimeType, name: metadata.name, sizeBytes: metadata.sizeBytes }
    },
    generated(sessionId: string, workspaceId: string, mimeType: string, data: string) {
      if (!isAllowedUploadType(mimeType) || !data.length ||
        data.length > 4 * Math.ceil(MAX_ATTACHMENT_BYTES / 3) ||
        data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
        throw new Error('Invalid generated image')
      }
      const bytes = Buffer.from(data, 'base64')
      if (!bytes.length || bytes.length > MAX_ATTACHMENT_BYTES) throw new Error('Image too large')
      const artifactId = randomUUID()
      const normalized = mimeType.toLowerCase()
      const metadata: ArtifactMetadata = { artifactId, sessionId, workspaceId,
        name: `generated-${artifactId}.${normalized === 'image/jpeg' ? 'jpg' : normalized.split('/')[1]}`,
        mimeType: normalized, sizeBytes: bytes.length, createdAt: Date.now(), source: 'generated' }
      const finalPath = path(artifactId)
      const partialDirectory = join(directory, 'partial')
      mkdirSync(partialDirectory, { recursive: true })
      const partialPath = join(partialDirectory, artifactId)
      try {
        writeFileSync(partialPath, bytes, { flag: 'wx' })
        renameSync(partialPath, finalPath)
        record(metadata)
      } catch (error) {
        rmSync(partialPath, { force: true })
        rmSync(finalPath, { force: true })
        throw error
      }
      return metadata
    },
  }
}
export type ArtifactStore = ReturnType<typeof createArtifactStore>
