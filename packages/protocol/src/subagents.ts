import { z } from 'zod'
import {
  EntityIdSchema,
  InteractionKindSchema,
  SubagentOriginSchema,
  TimestampSchema,
} from './domains.js'

/**
 * Subagents: agents a session's agent started to do part of its work.
 * See docs/decisions/subagents.md.
 *
 * Two origins share one record:
 *
 * - `native`: the provider's own subagent (Claude Code's `Agent` tool, an
 *   OpenCode or Cursor task). It runs inside the parent's provider process.
 *   Its work is filed as a child session of its own, but whether a person can
 *   prompt that child is the provider's call (`promptable`).
 * - `openmanager`: started through the environment's own `spawn_agent` tool,
 *   on any provider. Its child is an ordinary session the user can prompt.
 *
 * The record travels whole in `subagent.updated` on the parent's thread and in
 * the parent thread's snapshot, so a late joiner holds what a live one does.
 * The child session's own transcript travels on the child's thread, like any
 * session's.
 */

/** Bumped capability: an environment that files subagents and stops them. */
export const SUBAGENTS_CAPABILITY = 'subagents' as const

/** The most subagents one thread lists in its snapshot. */
export const SUBAGENTS_PER_THREAD_MAX = 500

/**
 * Where a subagent is. `waiting` means its work is blocked on the user: a
 * permission or question raised inside the child (`waitingOn` says which).
 * The last four are terminal.
 */
export const SubagentStatusSchema = z.enum([
  'pending',
  'running',
  'waiting',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
])

export function isSettledSubagentStatus(status: SubagentStatus): boolean {
  return (
    status === 'completed' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'interrupted'
  )
}

/** Running totals the provider reports. Each is absent until it is known. */
export const SubagentStatsSchema = z.object({
  toolCalls: z.number().int().nonnegative().optional(),
  tokens: z.number().int().nonnegative().optional(),
  durationMs: z.number().int().nonnegative().optional(),
})

export const SubagentSchema = z.object({
  /** The environment's id for this subagent. Stable for its whole life. */
  subagentId: EntityIdSchema,
  /** The session whose agent started it. */
  parentSessionId: EntityIdSchema,
  /** The parent turn it was started in. */
  turnId: EntityIdSchema,
  /**
   * The parent's tool call that started it: Claude's `Agent` call, or the
   * `spawn_agent` call. The parent chat shows the subagent's card in that tool
   * call's place. Absent when the provider names no tool call.
   */
  toolCallId: EntityIdSchema.optional(),
  /** The subagent that started this one, for a nested subagent. */
  parentSubagentId: EntityIdSchema.optional(),
  /** 1 for a subagent of a top-level session's agent, 2 for its child, and so on. */
  depth: z.number().int().positive(),
  origin: SubagentOriginSchema,
  /** The provider the subagent runs on: the parent's for a native one. */
  providerId: EntityIdSchema,
  /** The model it ran on, once known. */
  modelId: z.string().max(200).optional(),
  /** Its kind as the provider names it: `Explore`, `general-purpose`, a custom agent. */
  agentType: z.string().max(200).optional(),
  /** A short name for the card. */
  title: z.string().max(500),
  /** What it was asked, in the caller's words, cut to a preview. The child holds the whole prompt. */
  prompt: z.string().max(4000).optional(),
  status: SubagentStatusSchema,
  /** What a `waiting` subagent waits on. Absent otherwise. */
  waitingOn: InteractionKindSchema.optional(),
  /** True when it runs on after the turn that started it ended. */
  background: z.boolean(),
  /** Its child session, once filed. The card opens it. */
  childSessionId: EntityIdSchema.optional(),
  /**
   * Whether a person can send its child session a message. False for Claude
   * Code and Cursor subagents: only the parent agent can reach them.
   */
  promptable: z.boolean(),
  /** Whether `subagent.stop` can stop it while it runs. */
  stoppable: z.boolean(),
  stats: SubagentStatsSchema,
  /** What it is doing now: its latest tool call or progress summary, one line. */
  activity: z.string().max(500).optional(),
  /** Its final answer once settled, cut to a preview. The child holds the whole answer. */
  result: z.string().max(4000).optional(),
  /** Why it failed or was stopped, in the provider's words. */
  statusReason: z.string().max(1000).optional(),
  startedAt: TimestampSchema,
  finishedAt: TimestampSchema.optional(),
  updatedAt: TimestampSchema,
})

export const SubagentListSchema = z.array(SubagentSchema).max(SUBAGENTS_PER_THREAD_MAX)

export type SubagentStatus = z.infer<typeof SubagentStatusSchema>
export type SubagentStats = z.infer<typeof SubagentStatsSchema>
export type Subagent = z.infer<typeof SubagentSchema>
