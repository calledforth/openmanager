import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Where Claude Code keeps its transcripts: `<config dir>/projects/<project>/<id>.jsonl`. */
function projectsDir(env: NodeJS.ProcessEnv): string {
  const configured = env.CLAUDE_CONFIG_DIR?.trim()
  return join(configured || join(homedir(), '.claude'), 'projects')
}

/** The newest file of a list, or undefined when none exists. */
async function newest(paths: readonly string[]): Promise<string | undefined> {
  let found: { path: string; modified: number } | undefined
  for (const path of paths) {
    try {
      const info = await stat(path)
      if (info.isFile() && (!found || info.mtimeMs > found.modified)) {
        found = { path, modified: info.mtimeMs }
      }
    } catch {
      /* not in this project */
    }
  }
  return found?.path
}

/**
 * The transcript file of a session, from any project folder.
 *
 * Claude Code files a transcript under the folder the session started in, and
 * only some CLI versions find it by id from another folder (2.1.220 does not;
 * 2.1.312 does). Every version resumes from the file's path, appending to it
 * under the same id. A session that moved to another folder resumes that way.
 */
export async function findClaudeTranscript(
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  // A session id is a UUID; anything else must not become a path.
  if (!/^[0-9a-zA-Z-]+$/.test(sessionId)) return undefined
  const root = projectsDir(env)
  let projects: string[]
  try {
    projects = await readdir(root)
  } catch {
    return undefined
  }
  return newest(projects.map((project) => join(root, project, `${sessionId}.jsonl`)))
}
