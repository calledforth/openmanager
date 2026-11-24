import type { AgentTool, AgentToolResult } from '@agentpack/runtime/node'
import {
  isSettledSubagentStatus,
  type InteractionKind,
  type Subagent,
} from '@openmanager/protocol/node'
import { z } from 'zod'

/**
 * The tools that let any agent start a subagent on any provider: an ordinary
 * child session of ours, shown as a card in the parent chat like a native
 * subagent, and one a person can prompt. See docs/decisions/subagents.md.
 *
 * A child runs in the background by default. An MCP tool cannot start a turn
 * in the model, so the environment tells the parent when a child it has not
 * waited on settles, through the parent's queue (`subagent-wake.ts`). A wait
 * is capped below the minute some clients allow a tool call, and a wait that
 * runs out returns the handle rather than failing.
 */

export const SPAWN_AGENT_TOOL = 'spawn_agent'
export const WAIT_AGENT_TOOL = 'wait_agent'
export const SEND_AGENT_TOOL = 'send_agent'
export const LIST_AGENTS_TOOL = 'list_agents'
export const STOP_AGENT_TOOL = 'stop_agent'
export const LIST_ACTIVE_AGENTS_TOOL = 'list_active_agents'

/** Under the ~60 s some MCP clients allow a tool call, with room to answer. */
export const WAIT_MAX_MS = 45_000
/** How deep children of ours can nest: a child can start one more level. */
export const SPAWN_DEPTH_MAX = 2
/** Children of one session running at once. */
export const SPAWN_RUNNING_MAX = 4
/** Children one turn can start. */
export const SPAWN_PER_TURN_MAX = 8
/** How much of a child's answer a tool result carries before pointing at the rest. */
export const RESULT_INLINE_MAX = 12_000
/** Agents one listing shows before saying how many more there are. */
export const LIST_AGENTS_MAX = 60
/** How deep `list_agents` follows a lineage. */
const LINEAGE_DEPTH_MAX = 6
/** How much of what an agent was asked a listing quotes. */
const PROMPT_PREVIEW_MAX = 160

/** A provider a child can run on, as the environment knows it now. */
export interface SpawnProvider {
  providerId: string
  name: string
  /** False when its CLI is missing or signed out: a child there would fail at once. */
  available: boolean
  models: ReadonlyArray<{ modelId: string; name: string }>
  defaultModelId?: string
}

/** The calling session, as the tools need it. */
export interface SpawnCaller {
  sessionId: string
  providerId: string
  /** The caller's turn under way, if any: a spawn files the card in it. */
  turnId?: string
  /** 0 for a top-level session, 1 for a child of ours, and so on. */
  depth: number
  /** Its project, for `list_active_agents` with `scope: 'project'`. */
  workspaceId?: string
  /** The session it is filed under, when it is a subagent's. */
  parentSessionId?: string
}

/**
 * One agent `list_active_agents` shows: a session (top-level or a subagent's
 * child session), or a subagent whose child session is gone. Live ones, and
 * the agents above them for context.
 */
export interface ActiveAgent {
  /** The id to refer to it by: its session's, or the subagent's when it has no session. */
  id: string
  sessionId?: string
  /** The session of the agent that started it; absent for a top-level session. */
  parentSessionId?: string
  /** Set when it is a subagent. */
  subagentId?: string
  origin?: Subagent['origin']
  /** Its kind as its provider names it (`Explore`), for a native subagent. */
  agentType?: string
  workspaceId: string
  /** The project's name, as the user sees it. */
  projectName: string
  title: string
  providerId: string
  modelId?: string
  /** Running, waiting on the user, or (for an ancestor shown for context) neither. */
  live: boolean
  /** Its session's status, or a settled subagent's. */
  status: string
  waitingOn?: InteractionKind
  /** Running only through work its provider keeps going between turns. */
  inBackground?: boolean
  /** When what it is doing now started, when known. */
  startedAt?: string
  /** What it was asked, for a subagent: the start of its prompt. */
  prompt?: string
  /** What it is doing now, one line. */
  activity?: string
  toolCalls?: number
}

export interface SpawnHost {
  /** The session behind a runtime thread, or undefined once it is gone. */
  callerOf(threadId: string): SpawnCaller | undefined
  providers(): readonly SpawnProvider[]
  /** Start a child session and send it the prompt. Rejects with a message the model can act on. */
  spawn(args: {
    parent: SpawnCaller
    providerId: string
    modelId?: string
    title: string
    prompt: string
    background: boolean
  }): Promise<Subagent>
  /** Every subagent of ours the session started, oldest first. */
  list(parentSessionId: string): readonly Subagent[]
  /**
   * Every subagent filed under the session, of any origin (its own
   * provider's and ours), live or stored, oldest first. A nested one is
   * filed under its parent subagent's child session.
   */
  subagentsOf(sessionId: string): readonly Subagent[]
  /** Every agent live in the environment now, with the agents above each. */
  activeAgents(): readonly ActiveAgent[]
  get(parentSessionId: string, subagentId: string): Subagent | undefined
  /** Resolve once the child settles or the time runs out, with its record then. */
  waitSettled(parentSessionId: string, subagentId: string, timeoutMs: number): Promise<Subagent>
  /** The child's whole final answer, which the record only previews. */
  resultOf(parentSessionId: string, subagentId: string): string | undefined
  /** The parent has read this answer itself, so settling must not wake it. */
  markDelivered(parentSessionId: string, subagentId: string): void
  /** Send a follow-up: run now when the child is idle, queued after its turn when not. */
  send(parentSessionId: string, subagentId: string, message: string): Promise<'started' | 'queued'>
  stop(parentSessionId: string, subagentId: string): Promise<void>
}

const fail = (text: string): AgentToolResult => ({ text, isError: true })

const idSchema = z
  .string()
  .min(1)
  .max(256)
  .describe('The subagent id `spawn_agent` returned, or its session id as `list_agents` shows it.')

function line(subagent: Subagent): string {
  const parts = [
    `${subagent.subagentId} [${subagent.status}]`,
    `${subagent.providerId}${subagent.modelId ? `/${subagent.modelId}` : ''}`,
    subagent.title,
  ]
  return parts.join(' · ')
}

/** What a tool answers about one child: its state, and its answer once settled. */
export function describeSubagent(subagent: Subagent, fullResult: string | undefined): string {
  const head = line(subagent)
  if (!isSettledSubagentStatus(subagent.status)) {
    const doing = subagent.activity ? `\nNow: ${subagent.activity}` : ''
    const waiting = subagent.waitingOn
      ? `\nIt is waiting on the user (${subagent.waitingOn}); they answer on its page.`
      : ''
    return `${head}${doing}${waiting}`
  }
  const reason = subagent.statusReason ? `\nReason: ${subagent.statusReason}` : ''
  const answer = fullResult ?? subagent.result
  if (!answer) return `${head}${reason}\nIt gave no answer.`
  const cut =
    answer.length > RESULT_INLINE_MAX
      ? `${answer.slice(0, RESULT_INLINE_MAX)}\n[… ${answer.length - RESULT_INLINE_MAX} more characters on its page]`
      : answer
  return `${head}${reason}\nAnswer:\n${cut}`
}

/** Text on one line, cut to `max` characters. */
export function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat
}

/** A span of time the way a person says it: `45s`, `2m 05s`, `1h 03m`. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

const waitingText = (waitingOn: InteractionKind | undefined) =>
  waitingOn ? `waiting on ${waitingOn}` : 'waiting on the user'

function subagentState(subagent: Subagent, now: number): string {
  const status =
    subagent.status === 'waiting'
      ? waitingText(subagent.waitingOn)
      : subagent.status === 'pending'
        ? 'starting'
        : subagent.status
  const started = Date.parse(subagent.startedAt)
  const took = isSettledSubagentStatus(subagent.status)
    ? (subagent.stats.durationMs ??
      (subagent.finishedAt ? Date.parse(subagent.finishedAt) - started : undefined))
    : now - started
  const parts = [status]
  if (took !== undefined && Number.isFinite(took)) parts.push(formatElapsed(took))
  if (subagent.stats.toolCalls !== undefined) {
    parts.push(`${subagent.stats.toolCalls} tool call${subagent.stats.toolCalls === 1 ? '' : 's'}`)
  }
  return parts.join(', ')
}

const providerModel = (providerId: string, modelId: string | undefined) =>
  `${providerId}${modelId ? `/${modelId}` : ''}`

const howStarted = (subagent: Pick<Subagent, 'origin' | 'agentType'>) =>
  subagent.origin === 'openmanager'
    ? 'spawn_agent'
    : `its provider's own subagent${subagent.agentType ? ` (${subagent.agentType})` : ''}`

/** Live first, then oldest first. */
const liveFirst = <T>(
  items: readonly T[],
  live: (item: T) => boolean,
  started: (item: T) => string,
) =>
  [...items].sort((left, right) =>
    live(left) === live(right) ? started(left).localeCompare(started(right)) : live(left) ? -1 : 1,
  )

const RUNNING_NEXT =
  'It runs in the background. When it finishes you are told in a new message; do not poll it. Carry on with other work, and end your turn when there is none.'

export function createSpawnAgentTools(host: SpawnHost): readonly AgentTool[] {
  const callerOr = (threadId: string): SpawnCaller | AgentToolResult =>
    host.callerOf(threadId) ?? fail('This session is not known to OpenManager any more.')
  const isResult = (value: SpawnCaller | AgentToolResult): value is AgentToolResult =>
    'text' in value

  /** One of the caller's own children, by its subagent id or its session id. */
  const ownChild = (caller: SpawnCaller, id: string): Subagent | undefined =>
    host.get(caller.sessionId, id) ??
    host.list(caller.sessionId).find((child) => child.childSessionId === id)
  const noSuchChild = (id: string) =>
    fail(
      `This session has no subagent "${id}" of its own. list_agents shows the ones it can act on.`,
    )

  const providerList = () =>
    host
      .providers()
      .map((provider) => {
        const models = provider.models
          .slice(0, 12)
          .map((model) =>
            model.modelId === provider.defaultModelId
              ? `${model.modelId} (default)`
              : model.modelId,
          )
          .join(', ')
        const state = provider.available ? '' : ' (unavailable)'
        return `- ${provider.providerId}${state}: ${provider.name}${models ? `. Models: ${models}` : ''}`
      })
      .join('\n')

  const spawn: AgentTool = {
    name: SPAWN_AGENT_TOOL,
    description:
      'Start a subagent on any provider OpenManager runs (Claude, Codex, Cursor, OpenCode) to do one task. It starts with only `prompt`, none of your history, in your working directory. The user sees it as a card in this chat and can open it and talk to it. Runs in the background by default and you are told when it finishes. For work on your own provider, your own subagent tool is usually better; use this for another provider, or a child the user may want to talk to. `list_agents` lists providers and models; `send_agent`, `wait_agent` and `stop_agent` work on a child on any of them.',
    inputSchema: {
      provider: z
        .string()
        .min(1)
        .max(64)
        .describe('Provider id, e.g. `opencode`, `cursor`, `claude`, `codex`.'),
      model: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe("Model id; omit for the provider's default."),
      prompt: z
        .string()
        .min(1)
        .max(100_000)
        .describe('The whole task. The subagent sees nothing else, so include paths and context.'),
      title: z.string().min(1).max(120).describe('A short name for the card, 3-6 words.'),
      background: z
        .boolean()
        .optional()
        .describe(
          'Default true: return at once and be told when it finishes. False: wait up to 45 s for the answer, then return the handle if it is still running.',
        ),
    },
    async call(input, context) {
      const caller = callerOr(context.threadId)
      if (isResult(caller)) return caller
      if (caller.depth + 1 > SPAWN_DEPTH_MAX) {
        return fail(
          `A subagent started this way cannot start another past depth ${SPAWN_DEPTH_MAX}. Do the work yourself.`,
        )
      }
      const providerId = String(input.provider)
      const provider = host.providers().find((candidate) => candidate.providerId === providerId)
      if (!provider) {
        return fail(`There is no provider "${providerId}". Providers:\n${providerList()}`)
      }
      if (!provider.available) {
        return fail(
          `${provider.name} is not available on this machine right now. Providers:\n${providerList()}`,
        )
      }
      const modelId = typeof input.model === 'string' ? input.model : undefined
      if (
        modelId &&
        provider.models.length > 0 &&
        !provider.models.some((m) => m.modelId === modelId)
      ) {
        return fail(
          `${provider.name} has no model "${modelId}". Its models: ${provider.models.map((m) => m.modelId).join(', ')}`,
        )
      }
      const mine = host.list(caller.sessionId)
      const running = mine.filter((child) => !isSettledSubagentStatus(child.status)).length
      if (running >= SPAWN_RUNNING_MAX) {
        return fail(
          `${running} subagents of this session are still running, the most at once. Wait for one to finish (you are told when it does), or stop one with stop_agent.`,
        )
      }
      if (caller.turnId) {
        const thisTurn = mine.filter((child) => child.turnId === caller.turnId).length
        if (thisTurn >= SPAWN_PER_TURN_MAX) {
          return fail(`This turn already started ${thisTurn} subagents, the most one turn can.`)
        }
      }
      const background = input.background !== false
      let child: Subagent
      try {
        child = await host.spawn({
          parent: caller,
          providerId,
          ...(modelId ? { modelId } : {}),
          title: String(input.title),
          prompt: String(input.prompt),
          background,
        })
      } catch (error) {
        return fail(
          `The subagent did not start: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      if (background) return { text: `Started ${line(child)}.\n${RUNNING_NEXT}` }
      const settled = await host.waitSettled(caller.sessionId, child.subagentId, WAIT_MAX_MS)
      if (!isSettledSubagentStatus(settled.status)) {
        return {
          text: `${describeSubagent(settled, undefined)}\nStill running after 45 s. ${RUNNING_NEXT}`,
        }
      }
      host.markDelivered(caller.sessionId, child.subagentId)
      return { text: describeSubagent(settled, host.resultOf(caller.sessionId, child.subagentId)) }
    },
  }

  const wait: AgentTool = {
    name: WAIT_AGENT_TOOL,
    description:
      "Wait up to 45 s for one of your spawn_agent subagents (on any provider) to finish and read its answer. Only when this turn can't go on without it: you are told anyway when it finishes. A timeout does not stop it.",
    inputSchema: {
      id: idSchema,
      timeoutSeconds: z.number().int().min(0).max(45).optional().describe('Default and most: 45.'),
    },
    async call(input, context) {
      const caller = callerOr(context.threadId)
      if (isResult(caller)) return caller
      const found = ownChild(caller, String(input.id))
      if (!found) return noSuchChild(String(input.id))
      const id = found.subagentId
      const seconds = typeof input.timeoutSeconds === 'number' ? input.timeoutSeconds : 45
      const settled = await host.waitSettled(
        caller.sessionId,
        id,
        Math.min(seconds * 1000, WAIT_MAX_MS),
      )
      if (!isSettledSubagentStatus(settled.status)) {
        return { text: `${describeSubagent(settled, undefined)}\nStill running. ${RUNNING_NEXT}` }
      }
      host.markDelivered(caller.sessionId, id)
      return { text: describeSubagent(settled, host.resultOf(caller.sessionId, id)) }
    },
  }

  const send: AgentTool = {
    name: SEND_AGENT_TOOL,
    description:
      'Send one of your spawn_agent subagents (on any provider) a follow-up message. It keeps its own history. It runs now if the subagent is idle, or after its current turn. You are told when it finishes.',
    inputSchema: {
      id: idSchema,
      message: z.string().min(1).max(100_000),
    },
    async call(input, context) {
      const caller = callerOr(context.threadId)
      if (isResult(caller)) return caller
      const child = ownChild(caller, String(input.id))
      if (!child) return noSuchChild(String(input.id))
      const id = child.subagentId
      try {
        const how = await host.send(caller.sessionId, id, String(input.message))
        return {
          text:
            how === 'started'
              ? `Sent to ${line(child)}. ${RUNNING_NEXT}`
              : `Queued for ${line(child)} after its current turn. ${RUNNING_NEXT}`,
        }
      } catch (error) {
        return fail(`Not sent: ${error instanceof Error ? error.message : String(error)}`)
      }
    },
  }

  const list: AgentTool = {
    name: LIST_AGENTS_TOOL,
    description:
      "List this session's subagents as a tree: the ones it started with spawn_agent on any provider (Claude, Codex, Cursor, OpenCode) and its provider's own (Claude's Agent tool and the like), with any they started nested under them. Each shows its id and session id, status, provider/model, title, what it was asked, what it is doing now, how long it ran, and whether you can act on it with send_agent, wait_agent and stop_agent. Also lists the providers and models spawn_agent can use. Prefer this over your own task or agent listing tool: it shows the titles, providers and states the user sees in OpenManager. For agents outside this session, use list_active_agents.",
    inputSchema: {},
    async call(_input, context) {
      const caller = callerOr(context.threadId)
      if (isResult(caller)) return caller
      const now = Date.now()
      const lines: string[] = []
      let shown = 0
      let hidden = 0
      let live = 0
      let settled = 0
      const seen = new Set<string>()
      const walk = (sessionId: string, depth: number) => {
        const children = host.subagentsOf(sessionId).filter((child) => !seen.has(child.subagentId))
        const ordered = liveFirst(
          children,
          (child) => !isSettledSubagentStatus(child.status),
          (child) => child.startedAt,
        )
        for (const child of ordered) {
          seen.add(child.subagentId)
          if (isSettledSubagentStatus(child.status)) settled += 1
          else live += 1
          if (shown >= LIST_AGENTS_MAX) {
            hidden += 1
          } else {
            shown += 1
            lines.push(...lineageEntry(child, caller, depth, now))
          }
          if (child.childSessionId && depth + 1 < LINEAGE_DEPTH_MAX) {
            walk(child.childSessionId, depth + 1)
          }
        }
      }
      walk(caller.sessionId, 0)
      if (hidden > 0) lines.push(`+${hidden} more not shown.`)
      const head =
        live + settled === 0
          ? 'Subagents: none yet.'
          : `Subagents of this session, live first (${live} live, ${settled} finished):`
      return {
        text: `${[head, ...lines].join('\n')}\n\nProviders for spawn_agent:\n${providerList()}`,
      }
    },
  }

  const listActive: AgentTool = {
    name: LIST_ACTIVE_AGENTS_TOOL,
    description:
      'List every agent running right now in this OpenManager environment: top-level sessions and subagents of every provider (Claude, Codex, Cursor, OpenCode) and origin, as trees by project. Each shows the id to refer to it by, title, provider/model, status (running, waiting on the user, in background), how long it has run, what it is for, what it is doing now, and how it relates to you (you, your subagent, your parent, sibling). An idle agent above a live one is shown for context. Use it to see what else is at work, e.g. in the same folder before you change files. Read-only: you can only message or stop your own subagents (list_agents).',
    inputSchema: {
      scope: z
        .enum(['project', 'all'])
        .optional()
        .describe("Default 'all': every project. 'project': only this session's project."),
    },
    async call(input, context) {
      const caller = callerOr(context.threadId)
      if (isResult(caller)) return caller
      const scope = input.scope === 'project' ? 'project' : 'all'
      return { text: describeActiveAgents(host.activeAgents(), caller, scope, Date.now()) }
    },
  }

  const stop: AgentTool = {
    name: STOP_AGENT_TOOL,
    description:
      'Stop one of your spawn_agent subagents (on any provider). Its work so far stays on its page.',
    inputSchema: { id: idSchema },
    async call(input, context) {
      const caller = callerOr(context.threadId)
      if (isResult(caller)) return caller
      const child = ownChild(caller, String(input.id))
      if (!child) return noSuchChild(String(input.id))
      const id = child.subagentId
      if (isSettledSubagentStatus(child.status))
        return { text: `${line(child)} had already finished.` }
      try {
        await host.stop(caller.sessionId, id)
      } catch (error) {
        return fail(`Not stopped: ${error instanceof Error ? error.message : String(error)}`)
      }
      host.markDelivered(caller.sessionId, id)
      return { text: `Stopped ${line(child)}.` }
    },
  }

  return [spawn, wait, send, list, listActive, stop]
}

/** One subagent in `list_agents`: a head line, then what it is and what you can do with it. */
function lineageEntry(
  subagent: Subagent,
  caller: SpawnCaller,
  depth: number,
  now: number,
): string[] {
  const pad = '  '.repeat(depth)
  const head = `${pad}- ${subagent.title} [${subagentState(subagent, now)}] ${providerModel(subagent.providerId, subagent.modelId)} · ${howStarted(subagent)}`
  const ids = `id: ${subagent.subagentId}${subagent.childSessionId ? ` (session ${subagent.childSessionId})` : ''}`
  const reach =
    subagent.origin === 'openmanager' && subagent.parentSessionId === caller.sessionId
      ? 'yours: send_agent, wait_agent, stop_agent'
      : subagent.parentSessionId === caller.sessionId
        ? 'reach it with your own subagent tool, not send_agent'
        : 'started by a subagent of yours: only that subagent can act on it'
  const lines = [head, `${pad}  ${ids} · ${reach}`]
  if (subagent.prompt?.trim()) {
    lines.push(`${pad}  asked: ${oneLine(subagent.prompt, PROMPT_PREVIEW_MAX)}`)
  }
  if (!isSettledSubagentStatus(subagent.status) && subagent.activity?.trim()) {
    lines.push(`${pad}  now: ${oneLine(subagent.activity, PROMPT_PREVIEW_MAX)}`)
  }
  if (isSettledSubagentStatus(subagent.status) && subagent.statusReason?.trim()) {
    lines.push(`${pad}  reason: ${oneLine(subagent.statusReason, PROMPT_PREVIEW_MAX)}`)
  }
  return lines
}

/** How an agent stands to the caller, or undefined when it is unrelated. */
function relationTo(
  agent: ActiveAgent,
  caller: SpawnCaller,
  byId: ReadonlyMap<string, ActiveAgent>,
): string | undefined {
  if (agent.sessionId === caller.sessionId) return 'you'
  if (caller.parentSessionId && agent.sessionId === caller.parentSessionId) return 'your parent'
  // Further up than the caller's parent.
  let above = caller.parentSessionId ? byId.get(caller.parentSessionId) : undefined
  for (let hops = 0; above?.parentSessionId && hops < 16; hops += 1) {
    if (agent.sessionId === above.parentSessionId) return 'your ancestor'
    above = byId.get(above.parentSessionId)
  }
  for (let item: ActiveAgent | undefined = agent, hops = 0; item && hops < 16; hops += 1) {
    if (item.parentSessionId === caller.sessionId) {
      if (item !== agent) return "your subagent's subagent"
      return agent.origin === 'openmanager' ? 'your subagent (yours to act on)' : 'your subagent'
    }
    item = item.parentSessionId ? byId.get(item.parentSessionId) : undefined
  }
  if (caller.parentSessionId && agent.parentSessionId === caller.parentSessionId) return 'sibling'
  return undefined
}

function activeState(agent: ActiveAgent, now: number): string {
  if (!agent.live) return `${agent.status}, shown for the agents under it`
  const status =
    agent.status === 'waiting'
      ? waitingText(agent.waitingOn)
      : agent.inBackground
        ? 'running in background'
        : agent.status === 'pending'
          ? 'starting'
          : agent.status
  const parts = [status]
  const started = agent.startedAt ? Date.parse(agent.startedAt) : Number.NaN
  if (Number.isFinite(started)) parts.push(formatElapsed(now - started))
  if (agent.toolCalls !== undefined) {
    parts.push(`${agent.toolCalls} tool call${agent.toolCalls === 1 ? '' : 's'}`)
  }
  return parts.join(', ')
}

/** What `list_active_agents` answers: live agents as lineage trees, by project. */
export function describeActiveAgents(
  agents: readonly ActiveAgent[],
  caller: SpawnCaller,
  scope: 'project' | 'all',
  now: number,
): string {
  const byId = new Map<string, ActiveAgent>()
  for (const agent of agents) byId.set(agent.id, agent)
  const inScope = agents.filter(
    (agent) => scope === 'all' || !caller.workspaceId || agent.workspaceId === caller.workspaceId,
  )
  const others = inScope.filter((agent) => agent.live && agent.sessionId !== caller.sessionId)
  const where = scope === 'project' ? 'in this project' : 'in this environment'
  if (others.length === 0) {
    return `Nothing else is running ${where} right now: no other session and no subagent.`
  }
  const childrenOf = new Map<string, ActiveAgent[]>()
  const roots: ActiveAgent[] = []
  for (const agent of inScope) {
    const parent = agent.parentSessionId ? byId.get(agent.parentSessionId) : undefined
    if (parent && inScope.includes(parent)) {
      const list = childrenOf.get(parent.id) ?? []
      list.push(agent)
      childrenOf.set(parent.id, list)
    } else {
      roots.push(agent)
    }
  }
  const startedOf = (agent: ActiveAgent) => agent.startedAt ?? ''
  // The caller's own tree leads, then the caller's project, then the rest by name.
  const rootOf = (agent: ActiveAgent) => {
    let item = agent
    for (let hops = 0; item.parentSessionId && hops < 16; hops += 1) {
      const parent = byId.get(item.parentSessionId)
      if (!parent) break
      item = parent
    }
    return item
  }
  const callerRoot = byId.get(caller.sessionId) ? rootOf(byId.get(caller.sessionId)!) : undefined
  const projects = new Map<string, { name: string; roots: ActiveAgent[] }>()
  for (const root of roots) {
    const project = projects.get(root.workspaceId) ?? { name: root.projectName, roots: [] }
    project.roots.push(root)
    projects.set(root.workspaceId, project)
  }
  const projectOrder = [...projects.entries()].sort(([leftId, left], [rightId, right]) => {
    const leftMine = leftId === caller.workspaceId ? 0 : 1
    const rightMine = rightId === caller.workspaceId ? 0 : 1
    return leftMine - rightMine || left.name.localeCompare(right.name)
  })
  const lines: string[] = []
  let shown = 0
  let hidden = 0
  const render = (agent: ActiveAgent, depth: number) => {
    if (shown >= LIST_AGENTS_MAX) {
      hidden += 1
    } else {
      shown += 1
      const pad = '  '.repeat(depth)
      const relation = relationTo(agent, caller, byId)
      lines.push(
        `${pad}- ${agent.title} [${activeState(agent, now)}] ${providerModel(agent.providerId, agent.modelId)}${relation ? ` · ${relation}` : ''}`,
      )
      const kind =
        agent.subagentId === undefined
          ? ''
          : agent.origin === 'openmanager'
            ? `, subagent ${agent.subagentId} started with spawn_agent`
            : `, ${agent.agentType ? `${agent.agentType} ` : ''}subagent ${agent.subagentId} of its provider's own`
      lines.push(`${pad}  id: ${agent.id}${agent.id === agent.subagentId ? '' : kind}`)
      const purpose = agent.prompt?.trim() ? oneLine(agent.prompt, PROMPT_PREVIEW_MAX) : undefined
      if (purpose && purpose !== agent.title) lines.push(`${pad}  for: ${purpose}`)
      if (agent.live && agent.activity?.trim()) {
        lines.push(`${pad}  now: ${oneLine(agent.activity, PROMPT_PREVIEW_MAX)}`)
      }
    }
    const children = liveFirst(childrenOf.get(agent.id) ?? [], (item) => item.live, startedOf)
    for (const child of children) render(child, depth + 1)
  }
  for (const [, project] of projectOrder) {
    if (shown >= LIST_AGENTS_MAX) {
      const count = (agent: ActiveAgent): number =>
        1 + (childrenOf.get(agent.id) ?? []).reduce((sum, child) => sum + count(child), 0)
      hidden += project.roots.reduce((sum, root) => sum + count(root), 0)
      continue
    }
    lines.push('', `Project ${project.name}:`)
    const ordered = [...project.roots].sort((left, right) =>
      left === callerRoot
        ? -1
        : right === callerRoot
          ? 1
          : startedOf(left).localeCompare(startedOf(right)),
    )
    for (const root of ordered) render(root, 0)
  }
  if (hidden > 0) lines.push('', `+${hidden} more not shown.`)
  const live = inScope.filter((agent) => agent.live).length
  const context = inScope.length - live
  const head = `Agents running now ${where}: ${live} live${context ? `, ${context} idle shown for context` : ''}. Only your own spawn_agent subagents take send_agent, wait_agent and stop_agent.`
  return [head, ...lines].join('\n')
}
