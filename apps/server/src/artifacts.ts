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
  const get = (sessionId: string, artifactId: string) =>
    lookup.get(artifactId, sessionId) as ArtifactMetadata | undefined
  const path = (artifactId: string) => {
    // Only IDs minted by this store may name files, including after a restart.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(artifactId)) {
      throw new Error('Invalid artifact id')
    }
    return join(directory, artifactId)
  }
  const record = (metadata: ArtifactMetadata, clientId?: string) => {
    const result = insert.run(metadata.artifactId, clientId ?? null,
      `uploads/${metadata.artifactId}`, metadata.name, metadata.mimeType, metadata.sizeBytes,
      metadata.createdAt, metadata.source,
      JSON.stringify({ sessionId: metadata.sessionId, source: metadata.source }),
      metadata.sessionId, metadata.workspaceId)
    if (result.changes !== 1) throw new Error('Artifact session not found')
  }
  const read = (metadata: ArtifactMetadata) => {
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
  return {
    get, record, read, path,
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
