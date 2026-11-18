import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { AgentTool } from '@agentpack/runtime/node'
import { z } from 'zod'
import type { MoveRequest } from './thread-service.ts'
import type { WorkspaceRegistration } from './workspaces.ts'

export const MOVE_SESSION_TOOL = 'move_session'

const DESCRIPTION = `Move this OpenManager session to another project folder, so the user finds it under that project and your later turns run there.

Use it when the work belongs in a different folder from the one you are in: typically after you created a new project (for example from "No project"), or when the user asks you to continue in another repository. The folder must already exist; it is added to the user's projects if it is not one yet.

The move happens when this turn completes, and your conversation carries over; if the turn is stopped or fails, the session stays where it is. Until then your working directory is unchanged, so finish this turn with absolute paths into the new folder, and tell the user where the session went. Background commands you started stop when the session moves.`

/**
 * `move_session`: an agent moves its session to another workspace, adding
 * the folder as one when it is not yet. The thread service files the move
 * and applies it when the turn completes (`requestMove`).
 */
export function createMoveSessionTool(deps: {
  /** The folder the agent runs in while it has a turn under way. */
  agentTurnOf: (threadId: string) => { cwd: string } | undefined
  /** Why this session cannot move at all, asked before anything is registered. */
  moveRefusal: (threadId: string) => string | undefined
  /** Find or add the workspace at an absolute path. */
  register: (path: string) => WorkspaceRegistration
  requestMove: (threadId: string, workspaceId: string) => MoveRequest
}): AgentTool {
  return {
    name: MOVE_SESSION_TOOL,
    description: DESCRIPTION,
    inputSchema: {
      path: z
        .string()
        .min(1)
        .max(4096)
        .describe('The project folder to move to: absolute, or relative to your working directory.'),
    },
    async call(input, context) {
      const given = typeof input.path === 'string' ? input.path.trim() : ''
      if (!given) return { text: 'Pass the path of the folder to move to.', isError: true }
      const refusal = deps.moveRefusal(context.threadId)
      if (refusal) return { text: refusal, isError: true }
      const turn = deps.agentTurnOf(context.threadId)
      if (!turn) {
        return { text: 'This session has no turn under way to move from.', isError: true }
      }
      const expanded =
        given === '~' || given.startsWith('~/') ? join(homedir(), given.slice(1)) : given
      // Absolute or not, so `..` segments are resolved before registration sees the path.
      const registered = deps.register(resolve(turn.cwd, expanded))
      if (!registered.ok) return { text: registered.message, isError: true }
      const { workspace } = registered
      const move = deps.requestMove(context.threadId, workspace.workspaceId)
      if (!move.ok) return { text: move.message, isError: true }
      const background =
        move.backgroundTasks > 0
          ? ` The ${move.backgroundTasks === 1 ? 'background task' : `${move.backgroundTasks} background tasks`} still running here will stop when the session moves.`
          : ''
      return {
        text:
          `This session moves to the project "${workspace.name}" (${move.cwd}) when this turn completes. ` +
          `Your next turn runs there, with this conversation. Until then you are still in ${turn.cwd}: use absolute paths into ${move.cwd}.` +
          background,
      }
    },
  }
}
