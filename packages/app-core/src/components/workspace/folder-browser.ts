import type { FilesystemListing } from '@openmanager/environment-client'

export type FolderEntry = FilesystemListing['entries'][number]

/**
 * What the path field means: everything up to its last separator is the
 * folder being listed, and the text after it narrows that folder's children.
 * `~` alone is the home folder. With no separator yet there is no folder.
 */
export function splitBrowseInput(input: string): { folder: string | null; filter: string } {
  if (input === '~') return { folder: '~', filter: '' }
  const cut = Math.max(input.lastIndexOf('/'), input.lastIndexOf('\\'))
  if (cut === -1) return { folder: null, filter: input }
  return { folder: input.slice(0, cut + 1), filter: input.slice(cut + 1) }
}

/** The separator a path already uses, so the field never mixes styles. */
function separatorOf(path: string): string {
  return path.includes('\\') ? '\\' : '/'
}

/** A folder as the field shows it once you are inside: with its separator, ready for a name. */
export function asFolderInput(path: string): string {
  return /[\\/]$/.test(path) ? path : `${path}${separatorOf(path)}`
}

/**
 * The children the field's text matches, by prefix and ignoring case. Dot
 * folders stay out of the way unless the text asks for one.
 */
export function visibleFolders(entries: readonly FolderEntry[], filter: string): FolderEntry[] {
  const prefix = filter.toLowerCase()
  const showHidden = filter.startsWith('.')
  return entries.filter(
    (entry) =>
      (showHidden || !entry.name.startsWith('.')) && entry.name.toLowerCase().startsWith(prefix),
  )
}

/**
 * The folder Add registers: the listed folder itself when nothing is typed
 * after it, or the child the text names in full (exactly, else ignoring
 * case). A partial name names no folder, so there is nothing to add.
 */
export function addTarget(listing: FilesystemListing, filter: string): string | null {
  if (!filter) return listing.path
  const exact =
    listing.entries.find((entry) => entry.name === filter) ??
    listing.entries.find((entry) => entry.name.toLowerCase() === filter.toLowerCase())
  return exact?.path ?? null
}

/** The last segment of a path, or the path itself at a root (`C:\`, `/`). */
export function folderName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return cut === -1 || cut === trimmed.length - 1 ? path : trimmed.slice(cut + 1) || path
}
