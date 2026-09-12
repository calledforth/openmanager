import type { EnvironmentClient } from '@openmanager/environment-client'

/** Last path segment, for either separator; the whole path when there is none. */
export function workspaceNameFromPath(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  return trimmed.split(/[\\/]/).filter(Boolean).pop() ?? trimmed
}

/**
 * The browser has no folder picker for a directory on the environment host,
 * so the path is asked for as text. A real picker needs the environment to
 * list its file system (CAL-51); until then this is the only way in.
 */
export async function promptForWorkspace(
  client: EnvironmentClient,
  ask: (message: string) => string | null = (message) => window.prompt(message),
): Promise<void> {
  if (!client.supports('addWorkspace')) {
    throw new Error('This environment does not support adding workspaces yet.')
  }
  const path = ask('Path of the workspace on the environment host')?.trim()
  if (!path) return
  await client.commands.addWorkspace({ name: workspaceNameFromPath(path), path })
}
