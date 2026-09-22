import { useEffect, useState } from 'react'
import type { EnvironmentClient } from '@openmanager/environment-client'
import { useEnvironmentClientOptional } from '../providers/environment-client'
import type { ArtifactSource } from './attachments'

/** How long an object URL nobody shows is kept, so a remounting row reuses it. */
export const ARTIFACT_PREVIEW_IDLE_MS = 30_000

type Entry = {
  url?: string
  failed?: boolean
  users: number
  listeners: Set<() => void>
  release?: ReturnType<typeof setTimeout>
}

/**
 * Object URLs by client. The bytes belong to the credential that fetched
 * them, so a preview is never shared across clients, and a client that goes
 * away takes its entries with it.
 */
const previews = new WeakMap<EnvironmentClient, Map<string, Entry>>()

const keyOf = (artifact: ArtifactSource) => `${artifact.sessionId}/${artifact.artifactId}`

function acquire(client: EnvironmentClient, artifact: ArtifactSource, listener: () => void) {
  const entries = previews.get(client) ?? new Map<string, Entry>()
  previews.set(client, entries)
  const key = keyOf(artifact)
  let entry = entries.get(key)
  if (!entry) {
    const created: Entry = { users: 0, listeners: new Set() }
    entry = created
    entries.set(key, created)
    const settle = (patch: Pick<Entry, 'url' | 'failed'>) => {
      Object.assign(created, patch)
      for (const notify of [...created.listeners]) notify()
    }
    const read = client.fetchArtifact
      ? client.fetchArtifact(artifact)
      : Promise.reject(new Error('This host cannot read artifacts.'))
    read.then(
      (blob) => {
        // Dropped while the bytes were on their way: nothing will revoke a
        // URL minted now, so none is.
        if (entries.get(key) !== created) return
        settle({ url: URL.createObjectURL(blob) })
      },
      () => {
        // Forgotten rather than kept, so the next row to ask tries again.
        if (entries.get(key) === created) entries.delete(key)
        settle({ failed: true })
      },
    )
  }
  const held = entry
  clearTimeout(held.release)
  held.release = undefined
  held.users += 1
  held.listeners.add(listener)
  const release = () => {
    held.listeners.delete(listener)
    held.users -= 1
    if (held.users > 0 || entries.get(key) !== held) return
    held.release = setTimeout(() => {
      if (entries.get(key) === held) entries.delete(key)
      if (held.url) URL.revokeObjectURL(held.url)
    }, ARTIFACT_PREVIEW_IDLE_MS)
  }
  return { entry: held, release }
}

export type ArtifactPreview = { url?: string; failed: boolean }

/**
 * The object URL of an artifact's bytes, read through the environment client
 * so local and remote hosts present the same credential to the same route.
 * `url` is absent while the bytes load; `failed` means they will not arrive.
 */
export function useArtifactPreview(artifact: ArtifactSource | undefined): ArtifactPreview {
  const client = useEnvironmentClientOptional()
  const sessionId = artifact?.sessionId
  const artifactId = artifact?.artifactId
  const [preview, setPreview] = useState<ArtifactPreview & { key?: string }>({ failed: false })
  const key = sessionId && artifactId ? `${sessionId}/${artifactId}` : undefined

  useEffect(() => {
    if (!sessionId || !artifactId) return
    if (!client) {
      setPreview({ key: `${sessionId}/${artifactId}`, failed: true })
      return
    }
    const source = { sessionId, artifactId }
    const sync = () =>
      setPreview({ key: keyOf(source), url: held.entry.url, failed: held.entry.failed === true })
    const held = acquire(client, source, sync)
    sync()
    return held.release
  }, [artifactId, client, sessionId])

  // A row reused for another artifact must not flash the previous image.
  return preview.key === key ? { url: preview.url, failed: preview.failed } : { failed: false }
}

/** Read the artifact a message part names, if it names one. */
export function partArtifact(part: Record<string, unknown>): ArtifactSource | undefined {
  const value = part.artifact as Partial<ArtifactSource> | undefined
  return value && typeof value.sessionId === 'string' && typeof value.artifactId === 'string'
    ? { sessionId: value.sessionId, artifactId: value.artifactId }
    : undefined
}
