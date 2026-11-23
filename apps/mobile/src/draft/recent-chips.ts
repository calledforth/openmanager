import { userProjects, type WorkspaceEntry } from '@openmanager/app-core/logic'

/** How many recent projects the page offers as one-tap chips, as web's landing does. */
export const RECENT_CHIP_LIMIT = 4

/**
 * The recent projects the page offers beside the one picked: the
 * environment's, newest first, never "No project", one whose folder is gone,
 * or the one already picked. As web's landing chips.
 */
export function recentChipsOf(
  recents: readonly WorkspaceEntry[],
  current: string | null | undefined,
): WorkspaceEntry[] {
  return userProjects([...recents])
    .filter(
      (workspace) =>
        !workspace.missing &&
        (workspace.availability ?? 'available') === 'available' &&
        workspace.path !== current,
    )
    .slice(0, RECENT_CHIP_LIMIT)
}
