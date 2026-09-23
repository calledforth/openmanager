export type WorkspaceAvailability = 'available' | 'missing' | 'inaccessible'

export interface UnavailableWorkspaceCopy {
  /** Short badge beside the project name. */
  badge: string
  /** Why this environment cannot use the folder. */
  reason: string
  /** The on-disk change that brings it back. */
  fix: string
}

const MISSING: UnavailableWorkspaceCopy = {
  badge: 'MISSING',
  reason: 'The folder is missing or was moved on this environment.',
  fix: 'Restore the folder at this path, then try again.',
}

const INACCESSIBLE: UnavailableWorkspaceCopy = {
  badge: 'NO ACCESS',
  reason:
    'Permission denied: this environment cannot read the folder, or the folder was replaced by a link elsewhere.',
  fix: 'Restore read access, or put the real folder back in place of the link, then try again.',
}

/**
 * Plain words for a registered folder this environment cannot use. The two
 * causes need different fixes, so the sidebar and the recovery pane name the
 * cause rather than only marking the project unusable. An environment that
 * predates `availability` only sends `exists`, which reads as missing.
 */
export function describeUnavailableWorkspace(
  availability: WorkspaceAvailability | undefined,
): UnavailableWorkspaceCopy {
  return availability === 'inaccessible' ? INACCESSIBLE : MISSING
}
