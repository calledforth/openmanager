import { Directory, File, Paths } from 'expo-file-system'

/*
 * The images this phone has read, kept as files in its cache folder: a chat
 * opened again, or after the app restarts, shows them from disk instead of
 * asking the environment, which over a tunnel can take a second an image. An
 * artifact's bytes never change, so a kept image is never stale. One folder
 * per environment, deleted when the phone forgets it; Android may also clear
 * the cache folder itself when storage runs low.
 */

/** What every environment together may keep; the oldest images go first past it. */
export const IMAGE_CACHE_BUDGET_BYTES = 200 * 1024 * 1024

// Both IDs name files, so only the shapes the environment mints are used.
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/

const root = () => new Directory(Paths.cache, 'images')
const folderOf = (environmentId: string) => new Directory(root(), environmentId)

function fileOf(environmentId: string, artifactId: string): File | undefined {
  if (!SAFE_ID.test(environmentId) || !SAFE_ID.test(artifactId)) return undefined
  return new File(folderOf(environmentId), artifactId)
}

/** The kept image's `file://` URI, or undefined when it was never kept. Synchronous. */
export function keptImageUri(environmentId: string, artifactId: string): string | undefined {
  try {
    const file = fileOf(environmentId, artifactId)
    return file?.exists && file.size > 0 ? file.uri : undefined
  } catch {
    return undefined
  }
}

let trimmed = false

/**
 * Keep an image read as a base64 data URI, and answer the kept file's URI;
 * undefined when it could not be kept, and the data URI is shown instead.
 */
export function keepImage(
  environmentId: string,
  artifactId: string,
  dataUri: string,
): string | undefined {
  const comma = dataUri.indexOf(',')
  if (!dataUri.startsWith('data:image/') || !dataUri.slice(0, comma).endsWith(';base64')) {
    return undefined
  }
  try {
    const file = fileOf(environmentId, artifactId)
    if (!file) return undefined
    folderOf(environmentId).create({ intermediates: true, idempotent: true })
    // Written aside and moved in whole: a file cut short would show broken for good.
    const partial = new File(folderOf(environmentId), `${artifactId}.part`)
    partial.write(dataUri.slice(comma + 1), { encoding: 'base64' })
    if (file.exists) file.delete()
    partial.move(file)
    if (!trimmed) {
      trimmed = true
      // Off the image's own path: the first keep of each run checks the budget.
      setTimeout(() => trimKeptImages(), 5000)
    }
    return file.uri
  } catch {
    return undefined
  }
}

/** Drop the oldest kept images until all of them fit `budget`. */
export function trimKeptImages(budget: number = IMAGE_CACHE_BUDGET_BYTES) {
  try {
    const top = root()
    if (!top.exists) return
    const files: Array<{ file: File; size: number; at: number }> = []
    for (const folder of top.list()) {
      if (!(folder instanceof Directory)) continue
      for (const entry of folder.list()) {
        if (!(entry instanceof File)) continue
        // A partial file a crash left behind is never shown; it goes first.
        const at = entry.name.endsWith('.part') ? 0 : (entry.lastModified ?? 0)
        files.push({ file: entry, size: entry.size, at })
      }
    }
    let total = files.reduce((sum, { size }) => sum + size, 0)
    files.sort((a, b) => a.at - b.at)
    for (const { file, size, at } of files) {
      if (total <= budget && at !== 0) break
      file.delete()
      total -= size
    }
  } catch {
    // A cache that cannot be trimmed this run is trimmed the next.
  }
}

/** The phone forgot this environment: delete every image kept of it. */
export function forgetEnvironmentImages(environmentId: string) {
  if (!SAFE_ID.test(environmentId)) return
  try {
    const folder = folderOf(environmentId)
    if (folder.exists) folder.delete()
  } catch {
    // Left for Android's own cache clearing.
  }
}
