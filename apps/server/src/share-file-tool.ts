import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import type { AgentTool } from '@agentpack/runtime/node'
import { z } from 'zod'
import { ShareRefusedError, type ArtifactMetadata } from './artifacts.ts'

export const SHARE_FILE_TOOL = 'share_file'

const DESCRIPTION = `Show the user a video or image file inline in the chat, as a player they can watch on the web and on their phone.

Use it whenever the user should see a recording or picture you made: a screen recording of a UI flow (for example Playwright's \`recordVideo\`), a demo clip, a rendered chart or a screenshot. The file goes to the user only; none of its bytes enter your context, so sharing a large video costs you nothing.

Takes MP4, WebM, MOV, PNG, JPEG, WebP or GIF, up to 1 GB. The file is copied when shared, so you may delete or overwrite it afterwards. Prefer MP4 (H.264) or WebM for video: every browser and phone plays them.`

const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`

/**
 * `share_file`: an agent puts a file it made into the chat. The bytes go to
 * the artifact store and the turn gets a reference to them; the agent is
 * answered one line, so a video never reaches the model's context.
 */
export function createShareFileTool(deps: {
  /** The session the thread is working for, while it has a turn under way. */
  agentTurnOf: (
    threadId: string,
  ) => { sessionId: string; workspaceId: string; cwd: string } | undefined
  share: (sessionId: string, workspaceId: string, path: string) => Promise<ArtifactMetadata>
  present: (threadId: string, metadata: ArtifactMetadata) => boolean
}): AgentTool {
  return {
    name: SHARE_FILE_TOOL,
    description: DESCRIPTION,
    inputSchema: {
      path: z
        .string()
        .min(1)
        .max(4096)
        .describe('The file to show: absolute, or relative to your working directory.'),
    },
    async call(input, context) {
      const given = typeof input.path === 'string' ? input.path.trim() : ''
      if (!given) return { text: 'Pass the path of the file to share.', isError: true }
      const turn = deps.agentTurnOf(context.threadId)
      if (!turn) {
        return {
          text: 'This session has no turn under way, so there is nowhere to show the file.',
          isError: true,
        }
      }
      const expanded = given === '~' || given.startsWith('~/') ? join(homedir(), given.slice(1)) : given
      const path = isAbsolute(expanded) ? expanded : resolve(turn.cwd, expanded)
      let metadata: ArtifactMetadata
      try {
        metadata = await deps.share(turn.sessionId, turn.workspaceId, path)
      } catch (error) {
        if (error instanceof ShareRefusedError) return { text: error.message, isError: true }
        throw error
      }
      // A copy that never reached the transcript stays the session's, and
      // goes with it.
      if (!deps.present(context.threadId, metadata)) {
        return {
          text: 'The turn ended before the file could be shown. Nothing was shared.',
          isError: true,
        }
      }
      const kind = metadata.mimeType.startsWith('video/') ? 'video' : 'image'
      return {
        text: `Shared ${metadata.name} (${kind}, ${megabytes(metadata.sizeBytes)}) in the chat. The user can ${kind === 'video' ? 'play' : 'view'} it there; there is no need to describe how to open it.`,
      }
    },
  }
}
