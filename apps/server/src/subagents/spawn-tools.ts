import type { AgentTool, AgentToolResult } from '@agentpack/runtime/node'
import { isSettledSubagentStatus, type Subagent } from '@openmanager/protocol/node'
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
  .describe('The subagent id `spawn_agent` returned.')

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

const RUNNING_NEXT =
  'It runs in the background. When it finishes you are told in a new message; do not poll it. Carry on with other work, and end your turn when there is none.'

export function createSpawnAgentTools(host: SpawnHost): readonly AgentTool[] {
  const callerOr = (threadId: string): SpawnCaller | AgentToolResult =>
    host.callerOf(threadId) ?? fail('This session is not known to OpenManager any more.')
  const isResult = (value: SpawnCaller | AgentToolResult): value is AgentToolResult =>
    'text' in value

  const providerList = () =>
    host
      .providers()
      .map((provider) => {
        const models = provider.models
          .slice(0, 12)
          .map((model) =>
            model.modelId === provider.defaultModelId ? `${model.modelId} (default)` : model.modelId,
          )
          .join(', ')
        const state = provider.available ? '' : ' (unavailable)'
        return `- ${provider.providerId}${state}: ${provider.name}${models ? `. Models: ${models}` : ''}`
      })
      .join('\n')

  const spawn: AgentTool = {
    name: SPAWN_AGENT_TOOL,
    description:
      'Start a subagent on any provider OpenManager runs (Claude, Cursor, OpenCode, ...) to do one task. It starts with only `prompt`, none of your history, in your working directory. The user sees it as a card in this chat and can open it and talk to it. Runs in the background by default and you are told when it finishes. For work on your own provider, your own subagent tool is usually better; use this for another provider, or a child the user may want to talk to. `list_agents` lists providers and models.',
    inputSchema: {
      provider: z.string().min(1).max(64).describe('Provider id, e.g. `opencode`, `cursor`, `claude`.'),
      model: z.string().min(1).max(200).optional().describe("Model id; omit for the provider's default."),
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
        return fail(`${provider.name} is not available on this machine right now. Providers:\n${providerList()}`)
      }
      const modelId = typeof input.model === 'string' ? input.model : undefined
      if (modelId && provider.models.length > 0 && !provider.models.some((m) => m.modelId === modelId)) {
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
        return fail(`The subagent did not start: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (background) return { text: `Started ${line(child)}.\n${RUNNING_NEXT}` }
      const settled = await host.waitSettled(caller.sessionId, child.subagentId, WAIT_MAX_MS)
      if (!isSettledSubagentStatus(settled.status)) {
        return { text: `${describeSubagent(settled, undefined)}\nStill running after 45 s. ${RUNNING_NEXT}` }
      }
      host.markDelivered(caller.sessionId, child.subagentId)
      return { text: describeSubagent(settled, host.resultOf(caller.sessionId, child.subagentId)) }
    },
  }

  const wait: AgentTool = {
    name: WAIT_AGENT_TOOL,
    description:
      "Wait up to 45 s for one of your subagents to finish and read its answer. Only when this turn can't go on without it: you are told anyway when it finishes. A timeout does not stop it.",
    inputSchema: {
      id: idSchema,
      timeoutSeconds: z.number().int().min(0).max(45).optional().describe('Default and most: 45.'),
    },
    async call(input, context) {
      const caller = callerOr(context.threadId)
      if (isResult(caller)) return caller
      const id = String(input.id)
      if (!host.get(caller.sessionId, id)) return fail(`This session has no subagent "${id}".`)
      const seconds = typeof input.timeoutSeconds === 'number' ? input.timeoutSeconds : 45
      const settled = await host.waitSettled(caller.sessionId, id, Math.min(seconds * 1000, WAIT_MAX_MS))
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
      'Send one of your subagents a follow-up message. It keeps its own history. It runs now if the subagent is idle, or after its current turn. You are told when it finishes.',
    inputSchema: {
      id: idSchema,
      message: z.string().min(1).max(100_000),
    },
    async call(input, context) {
      const caller = callerOr(context.threadId)
      if (isResult(caller)) return caller
      const id = String(input.id)
      const child = host.get(caller.sessionId, id)
      if (!child) return fail(`This session has no subagent "${id}".`)
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
      'List the subagents this session started with spawn_agent and their state, and the providers and models a new one can use.',
    inputSchema: {},
    async call(_input, context) {
      const caller = callerOr(context.threadId)
      if (isResult(caller)) return caller
      const mine = host.list(caller.sessionId)
      const children = mine.length ? mine.map(line).join('\n') : 'None yet.'
      return { text: `Subagents:\n${children}\n\nProviders:\n${providerList()}` }
    },
  }

  const stop: AgentTool = {
    name: STOP_AGENT_TOOL,
    description: 'Stop one of your subagents. Its work so far stays on its page.',
    inputSchema: { id: idSchema },
    async call(input, context) {
      const caller = callerOr(context.threadId)
      if (isResult(caller)) return caller
      const id = String(input.id)
      const child = host.get(caller.sessionId, id)
      if (!child) return fail(`This session has no subagent "${id}".`)
      if (isSettledSubagentStatus(child.status)) return { text: `${line(child)} had already finished.` }
      try {
        await host.stop(caller.sessionId, id)
      } catch (error) {
        return fail(`Not stopped: ${error instanceof Error ? error.message : String(error)}`)
      }
      host.markDelivered(caller.sessionId, id)
      return { text: `Stopped ${line(child)}.` }
    },
  }

  return [spawn, wait, send, list, stop]
}
