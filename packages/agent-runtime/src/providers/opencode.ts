import type { SubtaskUpdate, ToolCall, ToolCallUpdate } from '@agentpack/contract'
import { subtaskStatusFromTool, type SubtaskToolContext } from '../backends/acp/extensions.js'
import type { ProviderConfig } from './index.js'

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

export const opencode: ProviderConfig = {
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
  capabilities: {
    canSetModel: true,
    canSetMode: true,
    canSetConfigOption: true,
    canDeleteSession: false,
    canLoadSession: true,
    canListSessions: false,
    canCancelPrompt: true,
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
}
