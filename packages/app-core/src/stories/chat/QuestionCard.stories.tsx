import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import type { Question, QuestionOutcome } from '@agentpack/contract'
import { QuestionCard } from '../../components/questions/ComposerQuestionPrompt'
import { useQuestionFlow } from '../../components/questions/useQuestionFlow'
import { MessageInputView } from '../../components/chat/MessageInputView'
import { composerFrame } from '../../components/chat/chatComposerStyles'
import type { PendingQuestion } from '../../providers/question-provider'
import { ThemeProvider } from '../../providers/theme-provider'
import inputMeta from './MessageInputView.stories'

const STACK: Question = {
  questionId: 'stack',
  prompt: 'Which parts of the stack should the migration touch?',
  allowMultiple: true,
  allowFreeText: true,
  options: [
    { optionId: 'db', label: 'Database schema', description: 'Add the new columns' },
    { optionId: 'api', label: 'API handlers', description: 'Accept and return the new fields' },
    { optionId: 'web', label: 'Web client', description: 'Forms and list views' },
    { optionId: 'mobile', label: 'Mobile client' },
    {
      optionId: 'docs',
      label: 'Docs',
      description:
        'Update the public API reference and the migration guide so integrators know what changed',
    },
  ],
}

const STRATEGY: Question = {
  questionId: 'strategy',
  prompt: 'How should existing rows be backfilled?',
  allowFreeText: true,
  options: [
    { optionId: 'batch', label: 'Batch job', description: 'One pass, during a quiet window' },
    { optionId: 'lazy', label: 'Lazily on read', description: 'No downtime, slower to converge' },
    { optionId: 'none', label: 'Leave them empty' },
  ],
}

const TESTS: Question = {
  questionId: 'tests',
  prompt: 'Add tests for the migration?',
  options: [
    { optionId: 'yes', label: 'Yes' },
    { optionId: 'no', label: 'No' },
  ],
}

function pending(questions: Question[]): PendingQuestion {
  return { requestId: 'req-1', questions, createdAt: 0, updatedAt: 0 }
}

/** The card and the composer under it, wired the way `MessageInput` wires them:
 * one flow, the composer borrowed as the free-text field. */
function QuestionHarness({ questions }: { questions: Question[] }) {
  const [request, setRequest] = useState<PendingQuestion | null>(() => pending(questions))
  const [outcome, setOutcome] = useState<QuestionOutcome | null>(null)
  const flow = useQuestionFlow(request, (next) => {
    setOutcome(next)
    setRequest(null)
  })
  return (
    <div className="flex w-full flex-col gap-3">
      {outcome ? (
        <pre
          data-testid="question-outcome"
          className="text-ui-xs whitespace-pre-wrap text-[var(--basis-text-muted)]"
        >
          {JSON.stringify(outcome, null, 2)}
        </pre>
      ) : null}
      <div className={flow ? composerFrame : undefined}>
        {flow ? <QuestionCard flow={flow} /> : null}
        <MessageInputView
          {...inputMeta.args}
          attachedTop={!!flow}
          textOverride={
            flow
              ? {
                  value: flow.text,
                  onChange: flow.setText,
                  placeholder: 'Or type your own answer…',
                  onSubmit: flow.advance,
                  canSubmit: flow.canAdvance,
                }
              : undefined
          }
        />
      </div>
    </div>
  )
}

const meta = {
  title: 'App/QuestionCard',
  component: QuestionHarness,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <ThemeProvider>
        <div className="flex min-h-screen items-end bg-[var(--basis-canvas-bg)] p-6">
          <div className="mx-auto w-full max-w-[48rem]">
            <Story />
          </div>
        </div>
      </ThemeProvider>
    ),
  ],
} satisfies Meta<typeof QuestionHarness>

export default meta
type Story = StoryObj<typeof meta>

export const MultiSelect: Story = { args: { questions: [STACK] } }

export const SingleSelect: Story = { args: { questions: [STRATEGY] } }

export const Flow: Story = { args: { questions: [STACK, STRATEGY, TESTS] } }
