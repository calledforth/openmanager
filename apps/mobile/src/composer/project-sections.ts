import {
  NO_PROJECT_NAME,
  noProjectOf,
  userProjects,
  type WorkspaceEntry,
} from '@openmanager/app-core/logic'

/** What the sections are made from: the environment's projects and its recents. */
export interface ProjectLists {
  /** Projects with session activity, newest first. */
  recents: readonly WorkspaceEntry[]
  /** Every project the environment has. */
  workspaces: readonly WorkspaceEntry[]
}

/** Why a project cannot be picked now; null when it can. */
export function projectUnavailable(entry: WorkspaceEntry): string | null {
  if (entry.missing || entry.availability === 'missing') {
    return 'Its folder is gone on the environment'
  }
  if (entry.availability === 'inaccessible') return 'The environment cannot open its folder'
  return null
}

export interface ProjectSection {
  /** `none` for rows that need no heading ("No project", search results). */
  id: 'none' | 'recent' | 'all'
  rows: WorkspaceEntry[]
}

/**
 * The project sheet's rows, as web's picker groups them: "No project" first
 * where the environment offers it, then the recent projects whose folders are
 * there, then every other project once (never a recent twice). A query
 * narrows one flat list by name or path; "No project" answers to "none",
 * "without" and "scratch" too. Only the environment's own projects are ever
 * listed: a recent it does not list is not one of its own.
 */
export function projectSheetSections(source: ProjectLists, query: string): ProjectSection[] {
  const needle = query.trim().toLowerCase()
  const noProject = noProjectOf(source.workspaces)
  const projects = userProjects(source.workspaces)
  if (needle) {
    const noProjectMatches =
      !!noProject &&
      [NO_PROJECT_NAME, 'none', 'without', 'scratch'].some((word) =>
        word.toLowerCase().includes(needle),
      )
    const matches = projects.filter(
      (entry) =>
        entry.name.toLowerCase().includes(needle) || entry.path.toLowerCase().includes(needle),
    )
    const rows = [...(noProject && noProjectMatches ? [noProject] : []), ...matches]
    return rows.length > 0 ? [{ id: 'none', rows }] : []
  }
  const listed = new Map(projects.map((entry) => [entry.path, entry]))
  const recents = userProjects(source.recents)
    .map((entry) => listed.get(entry.path))
    .filter(
      (entry): entry is WorkspaceEntry => entry !== undefined && projectUnavailable(entry) === null,
    )
  const recentPaths = new Set(recents.map((entry) => entry.path))
  const rest = projects.filter((entry) => !recentPaths.has(entry.path))
  return [
    ...(noProject ? [{ id: 'none' as const, rows: [noProject] }] : []),
    ...(recents.length > 0 ? [{ id: 'recent' as const, rows: recents }] : []),
    ...(rest.length > 0 ? [{ id: 'all' as const, rows: rest }] : []),
  ]
}
