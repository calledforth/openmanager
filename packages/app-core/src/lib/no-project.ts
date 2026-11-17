/**
 * "No project": the environment's own scratch workspace, where a session
 * that needs no repository runs in a folder of its own. It is a workspace
 * like any other on the wire (`Workspace.kind === 'scratch'`), so every list
 * of workspaces holds it; what users call their projects is the rest.
 */

/**
 * Its mark: a chat bubble of radius 92 on Phosphor's 256 grid, its tail at
 * the lower left, in short round dashes (width 18) with gaps wide enough to
 * still read as dashes at 14px. Web (`NoProjectIcon`) and the phone
 * (`NoProjectMark`) draw the same shape.
 */
export const NO_PROJECT_ICON_PATH = 'M82,209 A92,92 0 1 0 47,174 L34,222 Z'
export const NO_PROJECT_ICON_DASHES = '20 44'

/** What the scratch workspace is called wherever it is shown. */
export const NO_PROJECT_NAME = 'No project'

/** Whether this entry is "No project". */
export const isNoProject = (workspace: { scratch?: boolean } | null | undefined): boolean =>
  workspace?.scratch === true

/** The user's own projects: every workspace but "No project". */
export function userProjects<T extends { scratch?: boolean }>(workspaces: readonly T[]): T[] {
  return workspaces.filter((workspace) => !isNoProject(workspace))
}

/** "No project" among these workspaces, when the environment offers it and it can host a session. */
export function noProjectOf<T extends { scratch?: boolean; missing?: boolean }>(
  workspaces: readonly T[],
): T | undefined {
  return workspaces.find((workspace) => isNoProject(workspace) && !workspace.missing)
}
