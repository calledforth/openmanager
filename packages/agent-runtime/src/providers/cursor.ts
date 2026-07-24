import type {
  PlanDocument,
  PlanReviewOutcome,
  PlanTodo,
  PlanTodoStatus,
  Question,
  SubtaskUpdate,
} from '@agentpack/contract'
import { subtaskStatusFromTool } from '../backends/acp/extensions.js'
import type { ProviderConfig } from './index.js'

const str = (value: unknown): string => (typeof value === 'string' ? value : '')

const TODO_STATUSES: readonly PlanTodoStatus[] = [
  'pending',
  'in_progress',
  'completed',
  'cancelled',
]
const todoStatus = (value: unknown): PlanTodoStatus =>
  TODO_STATUSES.includes(value as PlanTodoStatus) ? (value as PlanTodoStatus) : 'pending'
const parseTodos = (value: unknown): PlanTodo[] =>
  (Array.isArray(value) ? value : []).map((raw, index) => {
    const todo = (raw ?? {}) as Record<string, unknown>
    return {
      id: str(todo.id) || `todo-${index}`,
      content: str(todo.content),
      status: todoStatus(todo.status),
    }
  })

/** Wire shape (cursor-agent 2026.07.01): {toolCallId, name?, overview?, plan:string,
 * todos:[{id,content,status}], isProject?, phases?:[{name, todos:[...]}]}. Params
 * carry no sessionId. An empty plan string is still a valid document. */
function parseCreatePlan(
  params: unknown,
): Omit<PlanDocument, 'requestId' | 'sessionId'> | undefined {
  if (!params || typeof params !== 'object') return undefined
  const p = params as Record<string, unknown>
  const phases = Array.isArray(p.phases)
    ? p.phases.map((raw) => {
        const phase = (raw ?? {}) as Record<string, unknown>
        return { name: str(phase.name), todos: parseTodos(phase.todos) }
      })
    : undefined
  return {
    ...(str(p.name) ? { name: str(p.name) } : {}),
    ...(str(p.overview) ? { overview: str(p.overview) } : {}),
    markdown: str(p.plan),
    todos: parseTodos(p.todos),
    ...(phases ? { phases } : {}),
  }
}

function respondCreatePlan(outcome: PlanReviewOutcome): unknown {
  if (outcome.outcome === 'accepted') return { outcome: { outcome: 'accepted' } }
  if (outcome.outcome === 'rejected')
    return { outcome: { outcome: 'rejected', reason: outcome.reason ?? 'User rejected plan' } }
  return { outcome: { outcome: 'cancelled' } }
}

/** Wire shape: {toolCallId, todos:[{id,content,status}], merge:boolean}. The
 * bridge discards the response. */
function parseUpdateTodos(params: unknown): { todos: PlanTodo[]; merge: boolean } | undefined {
  const p = (params ?? {}) as Record<string, unknown>
  if (!Array.isArray(p.todos)) return undefined
  return { todos: parseTodos(p.todos), merge: p.merge === true }
}

/** Wire shape (cursor-agent 2026.07.01): {toolCallId, title, questions:[{id, prompt,
 * options:[{id,label}], allowMultiple}]}. Params carry no sessionId. */
function parseAskQuestion(params: unknown): { title?: string; questions: Question[] } | undefined {
  const p = (params ?? {}) as Record<string, unknown>
  if (!Array.isArray(p.questions)) return undefined
  const questions: Question[] = p.questions.map((raw, index) => {
    const q = (raw ?? {}) as Record<string, unknown>
    return {
      questionId: str(q.id) || `q${index}`,
      prompt: str(q.prompt),
      options: (Array.isArray(q.options) ? q.options : []).map((rawOption, optionIndex) => {
        const option = (rawOption ?? {}) as Record<string, unknown>
        return { optionId: str(option.id) || `o${optionIndex}`, label: str(option.label) }
      }),
      allowMultiple: q.allowMultiple === true,
      allowFreeText: true,
    }
  })
  if (questions.length === 0) return undefined
  return { title: str(p.title) || undefined, questions }
}

/** Wire shape (cursor-agent 2026.07.01): subagentType is a nested tagged enum,
 * e.g. `{"custom":{"unspecified":{}}}` or `{"explore":{}}` — not the flat string
 * the tool docs suggest. Unwrap single-key objects to the innermost tag. */
function parseSubagentType(value: unknown, depth = 0): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined
  if (!value || typeof value !== 'object' || depth > 4) return undefined
  const keys = Object.keys(value as Record<string, unknown>)
  if (keys.length !== 1) return undefined
  const inner = (value as Record<string, unknown>)[keys[0]]
  return parseSubagentType(inner, depth + 1) ?? keys[0]
}

/** `cursor/task` fires as a BLOCKING request ~ms after the Task tool call
 * completes, carrying the metadata the fast-path tool_call never had:
 * {toolCallId, description, prompt, subagentType, model, agentId, durationMs}.
 * agentId is opaque — not loadable via session/load (verified live). */
function parseCursorTask(params: unknown): SubtaskUpdate | undefined {
  const p = (params ?? {}) as Record<string, unknown>
  const taskId = str(p.toolCallId)
  if (!taskId) return undefined
  return {
    taskId,
    ...(str(p.description) ? { description: str(p.description) } : {}),
    ...(str(p.prompt) ? { prompt: str(p.prompt) } : {}),
    ...(str(p.model) ? { modelId: str(p.model) } : {}),
    ...(typeof p.durationMs === 'number' ? { durationMs: p.durationMs } : {}),
    ...(parseSubagentType(p.subagentType)
      ? { subagentType: parseSubagentType(p.subagentType) }
      : {}),
  }
}

export const cursor: ProviderConfig = {
  id: 'cursor',
  displayName: 'Cursor',
  command: {
    bin: 'agent',
    args: ['acp'],
    envOverride: 'ACP_CURSOR_BIN',
    fallbackEnvOverride: 'ACP_AGENT_BIN',
  },
  auth: {
    methodHints: ['cursor_login', 'cursor'],
    tolerateAuthenticateFailure: false,
    loginInstruction: 'Sign in to Cursor and retry.',
  },
  quirks: { correlateSessionlessExtensionsToActivePrompt: true },
  capabilities: {
    canSetModel: true,
    canSetMode: true,
    canSetConfigOption: true,
    canDeleteSession: false,
    canLoadSession: true,
    canListSessions: true,
    canCancelPrompt: true,
    supportsPlans: true,
    supportsAvailableCommands: true,
    supportsUsage: true,
    supportsPermissionRequests: true,
    supportsAuthentication: true,
    supportsThoughtStreaming: true,
    supportsSubtasks: true,
    supportsExtensions: true,
    supportsQuestions: true,
  },
  extensions: {
    // Unlisted methods fall back to ExtensionRegistry defaults (requests →
    // cancelled outcome, notifications → no-op).
    requests: {
      // Fallback when the question wait is cancelled or times out.
      'cursor/ask_question': () => ({
        outcome: { outcome: 'skipped', reason: 'User skipped questions' },
      }),
    },
    questions: {
      'cursor/ask_question': {
        parse: parseAskQuestion,
        respond: (outcome) => {
          if (outcome.outcome !== 'answered')
            return { outcome: { outcome: 'skipped', reason: 'User skipped questions' } }
          return {
            outcome: {
              outcome: 'answered',
              answers: outcome.answers.map((answer) => ({
                questionId: answer.questionId,
                // The ACP bridge drops freeform_text, so ship typed answers as an
                // option id — ids are semantic strings the model reads directly.
                selectedOptionIds: [
                  ...(answer.selectedOptionIds ?? []),
                  ...(answer.text?.trim() ? [answer.text.trim()] : []),
                ],
              })),
            },
          }
        },
      },
    },
    plans: {
      'cursor/create_plan': { parse: parseCreatePlan, respond: respondCreatePlan },
    },
    planSnapshots: {
      'cursor/update_todos': parseUpdateTodos,
    },
  },
  subtasks: {
    // Live: one opaque `Task` tool_call (fast path: title "Task: Subagent task",
    // rawInput only {_toolName:"task"}); the subagent's own activity never
    // streams. Completion rawOutput is {durationMs, isBackground}.
    fromToolCall: (tool, { tracked }) => {
      const input = (tool.rawInput ?? {}) as Record<string, unknown>
      if (!tracked && input._toolName !== 'task') return undefined
      const output = (tool.rawOutput ?? {}) as Record<string, unknown>
      const title = str(tool.title)
        .replace(/^Task:\s*/, '')
        .trim()
      return {
        taskId: tool.toolCallId,
        status: subtaskStatusFromTool(tool.status),
        ...(title ? { title } : {}),
        ...(str(input.description) ? { description: str(input.description) } : {}),
        ...(str(input.prompt) ? { prompt: str(input.prompt) } : {}),
        ...(parseSubagentType(input.subagentType)
          ? { subagentType: parseSubagentType(input.subagentType) }
          : {}),
        ...(typeof output.durationMs === 'number' ? { durationMs: output.durationMs } : {}),
      }
    },
    fromExtension: {
      'cursor/task': parseCursorTask,
    },
  },
}
