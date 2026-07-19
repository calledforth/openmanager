import type { Question } from '@agentpack/contract'
import type { ProviderConfig } from './index.js'

const str = (value: unknown): string => (typeof value === 'string' ? value : '')

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
    canCancelPrompt: true,
    supportsPlans: true,
    supportsAvailableCommands: true,
    supportsUsage: true,
    supportsPermissionRequests: true,
    supportsAuthentication: true,
    supportsThoughtStreaming: true,
    supportsSubtasks: false,
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
  },
}
