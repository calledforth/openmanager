import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { AgentTool } from '@agentpack/runtime/node'
import { z } from 'zod'
import type { MoveRequest } from './thread-service.ts'
import type { WorkspaceRegistration } from './workspaces.ts'

export const MOVE_SESSION_TOOL = 'move_session'

const DESCRIPTION = `Move this OpenManager session to another project folder, so the user finds it under that project and your work continues there.

Use it when the work belongs in a different folder from the one you are in: typically after you created a new project (for example from "No project"), or when the user asks you to continue in another repository. The folder must already exist; it is added to the user's projects if it is not one yet.

The move happens when this turn completes, and then your next turn starts by itself in the new folder, with this conversation; that project's instructions and settings apply there. So after calling this, wrap up briefly: say where the session is moving and end your turn, and carry on with the work in that next turn. If the turn is stopped or fails, the session stays where it is and nothing resumes. Background commands you started stop when the session moves.`

/**
 * `move_session`: an agent moves its session to another workspace, adding
 * the folder as one when it is not yet. The thread service files the move,
 * applies it when the turn completes and starts the next turn in the new
 * folder by itself (`requestMove`).
 */
export function createMoveSessionTool(deps: {
  /** The folder the agent runs in while it has a turn under way. */
  agentTurnOf: (threadId: string) => { cwd: string } | undefined
  /** Why this session cannot move at all, asked before anything is registered. */
  moveRefusal: (threadId: string) => string | undefined
  /** Find or add the workspace at an absolute path. */
  register: (path: string) => WorkspaceRegistration
  requestMove: (threadId: string, workspaceId: string, name: string) => MoveRequest
}): AgentTool {
  return {
    name: MOVE_SESSION_TOOL,
    description: DESCRIPTION,
    inputSchema: {
      path: z
        .string()
        .min(1)
        .max(4096)
        .describe(
          'The project folder to move to: absolute, or relative to your working directory.',
        ),
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
      const move = deps.requestMove(context.threadId, workspace.workspaceId, workspace.name)
      if (!move.ok) return { text: move.message, isError: true }
      const background =
        move.backgroundTasks > 0
          ? ` The ${move.backgroundTasks === 1 ? 'background task' : `${move.backgroundTasks} background tasks`} still running here will stop when the session moves.`
          : ''
      return {
        text:
          `This session moves to the project "${workspace.name}" (${move.cwd}) when this turn completes, ` +
          `and your next turn then starts there by itself, with this conversation. ` +
          `End this turn now: say in a sentence where the session is moving, and leave the rest of the work for that turn. ` +
          `Until it ends you are still in ${turn.cwd}. If this turn is stopped or fails, the session stays where it is.` +
          background,
      }
    },
  }
}
