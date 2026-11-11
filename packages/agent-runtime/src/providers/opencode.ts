import type { SubtaskUpdate, ToolCall, ToolCallUpdate } from '@agentpack/contract'
import { subtaskStatusFromTool, type SubtaskToolContext } from '../backends/acp/extensions.js'
import type { AcpProviderConfig } from './index.js'
import { createOpencodeModelImageInputLookup, listOpencodeModels } from './opencode-models.js'

const str = (value: unknown): string => (typeof value === 'string' ? value : '')

/** Wire shape (OpenCode 1.17.15): the `task` tool call arrives with title
 * "task" / kind "think" and empty rawInput; in_progress updates carry
 * {description, subagent_type, prompt}; the completed update's rawOutput is
 * {output, metadata:{sessionId, parentSessionId, model:{modelID, providerID}}}
 * where metadata.sessionId is the child session — loadable via session/load
 * (verified live). The output text wraps the result in
 * `<task id="..." state="..."><task_result>...</task_result></task>`. */
function opencodeSubtaskFromTool(
  tool: ToolCall | ToolCallUpdate,
  { phase, tracked }: SubtaskToolContext,
): SubtaskUpdate | undefined {
  const input = (tool.rawInput ?? {}) as Record<string, unknown>
  const isTask =
    tracked ||
    (phase === 'call' && tool.title === 'task' && tool.kind === 'think') ||
    Boolean(str(input.subagent_type))
  if (!isTask) return undefined
  const output = (tool.rawOutput ?? {}) as Record<string, unknown>
  const metadata = (output.metadata ?? {}) as Record<string, unknown>
  const model = (metadata.model ?? {}) as Record<string, unknown>
  const outputText = str(output.output)
  const childSessionId =
    str(metadata.sessionId) || (/<task\s+id="([^"]+)"/.exec(outputText)?.[1] ?? '')
  const resultText = (/<task_result>([\s\S]*?)<\/task_result>/.exec(outputText)?.[1] ?? '').trim()
  const wrapperState = /<task\s[^>]*state="([^"]+)"/.exec(outputText)?.[1]
  const failed = wrapperState === 'failed' || wrapperState === 'error'
  const interruptionReason = str(output.error)
  const interrupted =
    metadata.interrupted === true || /abort|cancel|interrupt/i.test(interruptionReason)
  const modelId = str(model.modelID)
    ? [str(model.providerID), str(model.modelID)].filter(Boolean).join('/')
    : ''
  const title = tool.title && tool.title !== 'task' ? tool.title : undefined
  return {
    taskId: tool.toolCallId,
    status: interrupted ? 'interrupted' : failed ? 'failed' : subtaskStatusFromTool(tool.status),
    ...(interrupted
      ? { statusReason: interruptionReason || 'Provider interrupted the delegated task' }
      : {}),
    ...(title ? { title } : {}),
    ...(str(input.description) ? { description: str(input.description) } : {}),
    ...(str(input.prompt) ? { prompt: str(input.prompt) } : {}),
    ...(str(input.subagent_type) ? { subagentType: str(input.subagent_type) } : {}),
    ...(modelId ? { modelId } : {}),
    ...(childSessionId ? { childSessionId } : {}),
    ...(resultText ? { resultText } : {}),
  }
}

/**
 * OpenCode asks before an MCP tool only when its permission config says so
 * (none by default; `"*": "ask"` asks for everything). Its permission prompt
 * carries nothing structural: the title is the tool id for an MCP tool, and
 * the command, pattern or path for bash, grep and patch, so a title match
 * would also allow a shell command spelled like our tool. Instead the host's
 * tools are allowed in OpenCode's own config, by their exact tool ids
 * (`{server}_{tool}`), through `OPENCODE_CONFIG_CONTENT`, which OpenCode
 * merges over the global and project config (verified with 1.19.5: a project
 * `"*": "ask"` and an explicit deny for the tool are both overridden, and
 * bash still asks). A user's own `OPENCODE_CONFIG_CONTENT` is kept and
 * extended; one that is not a JSON object is left alone, and the tool then
 * asks like any other.
 */
export function opencodeAllowHostTools(
  tools: { serverName: string; toolNames: readonly string[] },
  env: Readonly<Record<string, string>>,
): Record<string, string> {
  const sanitize = (name: string) => name.replace(/[^a-zA-Z0-9_-]/g, '_')
  let content: Record<string, unknown> = {}
  const existing = env.OPENCODE_CONFIG_CONTENT?.trim()
  if (existing) {
    try {
      const parsed: unknown = JSON.parse(existing)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
      content = parsed as Record<string, unknown>
    } catch {
      return {}
    }
  }
  const current = content.permission
  // A bare string is OpenCode's shorthand for every permission.
  const permission: Record<string, unknown> =
    typeof current === 'string'
      ? { '*': current }
      : current && typeof current === 'object' && !Array.isArray(current)
        ? { ...(current as Record<string, unknown>) }
        : {}
  for (const name of tools.toolNames) {
    permission[`${sanitize(tools.serverName)}_${sanitize(name)}`] = 'allow'
  }
  return { OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...content, permission }) }
}

export const opencode: AcpProviderConfig = {
  kind: 'acp',
  id: 'opencode',
  displayName: 'OpenCode',
  command: {
    bin: 'opencode',
    args: ['acp'],
    envOverride: 'ACP_OPENCODE_BIN',
    // OpenCode classifies ACP as a non-interactive client and otherwise omits
    // its first-class question tool from the model's tool inventory.
    env: { OPENCODE_ENABLE_QUESTION_TOOL: 'true' },
  },
  auth: {
    methodHints: ['opencode-login', 'opencode', 'login'],
    tolerateAuthenticateFailure: true,
    loginInstruction: 'Run `opencode auth login` and retry.',
  },
  quirks: { suppressPlanUpdates: true, nativeQuestions: 'opencode' },
  allowHostTools: opencodeAllowHostTools,
  capabilities: {
    canSetModel: true,
    canSetMode: true,
    canSetConfigOption: true,
    canDeleteSession: false,
    canLoadSession: true,
    canListSessions: false,
    canCancelPrompt: true,
    // ACP has no way to add to a running prompt; a message sent mid-turn queues.
    canSteer: false,
    supportsPlans: false,
    supportsAvailableCommands: true,
    supportsUsage: true,
    supportsPermissionRequests: true,
    supportsAuthentication: true,
    supportsThoughtStreaming: true,
    supportsSubtasks: true,
    supportsExtensions: false,
    supportsQuestions: true,
  },
  extensions: {},
  subtasks: { fromToolCall: opencodeSubtaskFromTool },
  models: {
    // ACP's catalog says nothing about vision; OpenCode's own CLI does.
    imageInput: (deps) => createOpencodeModelImageInputLookup(deps),
    // Over the CLI rather than `session/new`: OpenCode keeps every session it
    // opens, so asking over ACP would add an empty "New session" to the
    // user's own history each time the catalog was read.
    catalog: { via: 'cli', list: (deps) => listOpencodeModels(deps) },
  },
}
