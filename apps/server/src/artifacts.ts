import { randomUUID } from 'node:crypto'
import { constants, mkdirSync, readFileSync, statSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { copyFile, open, stat, statfs } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { extensionOf, sniffMedia, SNIFF_BYTES } from './media-sniff.ts'
import {
  isAllowedUploadType,
  MAX_ATTACHMENT_BYTES,
  MAX_SHARED_BYTES_PER_SESSION,
  MAX_SHARED_FILE_BYTES,
  MAX_SHARED_IMAGE_BYTES,
  megabytes,
  SHARE_DISK_HEADROOM_BYTES,
  SHAREABLE_NAMES,
  type ShareableType,
} from './upload-limits.ts'

/** Why a file an agent shared was refused, in words the agent can act on. */
export class ShareRefusedError extends Error {}

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
  const sharedBytes = database.prepare(`
    SELECT COALESCE(SUM(size_bytes), 0) AS total FROM attachments
    WHERE session_id = ? AND source = 'generated'
  `)
  const deleteOwned = database.prepare(
    'DELETE FROM attachments WHERE attachment_id = ? AND session_id = ?',
  )
  /** Bytes of shares still being copied, by session, so two at once both count. */
  const sharing = new Map<string, number>()
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
        name: `generated-${artifactId}.${extensionOf(normalized as ShareableType)}`,
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
    /**
     * Copy a file an agent shared into the store, as the session's own: the
     * chat keeps showing it after the agent moves or deletes the original.
     * What it is comes from its bytes (`sniffMedia`), never its name, and it
     * is checked on the copy, so a file rewritten mid-copy is judged as kept.
     */
    async share(sessionId: string, workspaceId: string, sourcePath: string) {
      let source
      try {
        source = await stat(sourcePath)
      } catch {
        throw new ShareRefusedError(`There is no file at ${sourcePath}.`)
      }
      if (!source.isFile()) throw new ShareRefusedError(`${sourcePath} is not a file.`)
      if (source.size === 0) throw new ShareRefusedError(`${sourcePath} is empty.`)
      const tooLarge = () =>
        new ShareRefusedError(
          `${sourcePath} is larger than ${megabytes(MAX_SHARED_FILE_BYTES)}, the most a shared file may be.`,
        )
      if (source.size > MAX_SHARED_FILE_BYTES) throw tooLarge()
      const held =
        (sharedBytes.get(sessionId) as { total: number }).total + (sharing.get(sessionId) ?? 0)
      if (held + source.size > MAX_SHARED_BYTES_PER_SESSION) {
        throw new ShareRefusedError(
          `This session has already shared ${megabytes(held)}; sharing ${sourcePath} would pass the ${megabytes(MAX_SHARED_BYTES_PER_SESSION)} a session may share.`,
        )
      }
      const disk = await statfs(directory)
      if (disk.bavail * disk.bsize < source.size + SHARE_DISK_HEADROOM_BYTES) {
        throw new ShareRefusedError(
          `The environment's disk is nearly full, so ${sourcePath} was not copied.`,
        )
      }
      sharing.set(sessionId, (sharing.get(sessionId) ?? 0) + source.size)
      const settle = () => {
        const left = (sharing.get(sessionId) ?? 0) - source.size
        if (left > 0) sharing.set(sessionId, left)
        else sharing.delete(sessionId)
      }
      const artifactId = randomUUID()
      const partialDirectory = join(directory, 'partial')
      const partialPath = join(partialDirectory, artifactId)
      const finalPath = path(artifactId)
      try {
        mkdirSync(partialDirectory, { recursive: true })
        await copyFile(sourcePath, partialPath, constants.COPYFILE_EXCL)
        const copied = await stat(partialPath)
        if (copied.size === 0 || copied.size > MAX_SHARED_FILE_BYTES) throw tooLarge()
        const head = new Uint8Array(SNIFF_BYTES)
        const handle = await open(partialPath, 'r')
        try {
          await handle.read(head, 0, SNIFF_BYTES, 0)
        } finally {
          await handle.close()
        }
        const mimeType = sniffMedia(head)
        if (!mimeType) {
          throw new ShareRefusedError(
            `${sourcePath} is not a video or image the chat can show (${SHAREABLE_NAMES}).`,
          )
        }
        // An image is read whole wherever it is shown; only video streams.
        if (mimeType.startsWith('image/') && copied.size > MAX_SHARED_IMAGE_BYTES) {
          throw new ShareRefusedError(
            `${sourcePath} is an image larger than ${megabytes(MAX_SHARED_IMAGE_BYTES)}, the most a shared image may be. Shrink or compress it and share it again.`,
          )
        }
        // The original's name, for the viewer and a download; never a path here.
        const stem = basename(sourcePath).replace(/\.[^.]*$/, '').slice(0, 200) || 'shared'
        const metadata: ArtifactMetadata = {
          artifactId, sessionId, workspaceId,
          name: `${stem}.${extensionOf(mimeType)}`,
          mimeType, sizeBytes: copied.size, createdAt: Date.now(), source: 'generated',
        }
        renameSync(partialPath, finalPath)
        record(metadata)
        return metadata
      } catch (error) {
        rmSync(partialPath, { force: true })
        rmSync(finalPath, { force: true })
        throw error
      } finally {
        settle()
      }
    },
    /** Remove a shared copy that never reached the transcript: row, then bytes. */
    discard(metadata: Pick<ArtifactMetadata, 'artifactId' | 'sessionId'>) {
      if (deleteOwned.run(metadata.artifactId, metadata.sessionId).changes === 1) {
        removeBytes(metadata.artifactId)
      }
    },
    /**
     * Where an artifact's bytes are, for a reply that sends them in ranges
     * rather than reading them whole: checked as `read` checks, against the
     * shared-file ceiling instead of the attachment one.
     */
    file(metadata: Pick<ArtifactMetadata, 'artifactId' | 'sizeBytes'>) {
      const filePath = path(metadata.artifactId)
      const found = statSync(filePath)
      if (!found.isFile() || found.size !== metadata.sizeBytes || found.size > MAX_SHARED_FILE_BYTES) {
        throw new Error('Artifact size mismatch')
      }
      return { path: filePath, sizeBytes: found.size }
    },
  }
}
export type ArtifactStore = ReturnType<typeof createArtifactStore>
