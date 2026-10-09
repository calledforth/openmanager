import type { Meta, StoryObj } from '@storybook/react-vite'
import type { DurableTurnNotice, TransientTurnNotice, TurnFailure } from '@openmanager/protocol'
import { ChatViewPanel, AssistantMessage } from '../../components/chat/ChatViewPrimitives'
import { failurePart, noticePart } from '../../lib/turn-notice-parts'
import { TurnRecoveryContext, type TurnRecoveryValue } from '../../providers/turn-recovery'

const meta = {
  title: 'App/TurnNotices',
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
} satisfies Meta

export default meta
type Story = StoryObj

type Part = { type: string; id: string; [key: string]: unknown }

const recovery: TurnRecoveryValue = {
  retry: async () => undefined,
  compact: async () => undefined,
  providerName: 'Claude',
  busy: false,
}

const inHours = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString()

const durable = (notice: Omit<DurableTurnNotice, 'turnId'>) =>
  noticePart({ turnId: 't1', ...notice })
const live = (notice: Omit<TransientTurnNotice, 'turnId'>) =>
  noticePart({ turnId: 't1', ...notice }, true)
const failed = (failure: TurnFailure, actionable = true) => failurePart('t1', failure, actionable)

const text = (id: string, value: string): Part => ({ type: 'text', id, text: value })
const read = (id: string, path: string): Part => ({
  type: 'tool',
  id,
  tool: 'Read File',
  kind: 'read',
  callID: id,
  state: { status: 'completed', input: { path }, output: `contents of ${path}` },
})

function Frame({ parts, isStreaming }: { parts: Part[]; isStreaming?: boolean }) {
  return (
    <TurnRecoveryContext.Provider value={recovery}>
      <div className="h-screen w-screen bg-background">
        <ChatViewPanel>
          <div className="mx-auto w-full max-w-2xl px-4 py-6">
            <AssistantMessage content="" isFinal={!isStreaming} parts={parts} />
          </div>
        </ChatViewPanel>
      </div>
    </TurnRecoveryContext.Provider>
  )
}

/** The provider is retrying a request: a live line at the end of the turn. */
export const Retrying: Story = {
  render: () => (
    <Frame
      isStreaming
      parts={[
        read('r1', 'src/server.ts'),
        live({
          noticeId: 'n1',
          kind: 'retrying',
          message: 'Retrying after the provider was overloaded (attempt 2 of 10)',
          retry: { attempt: 2, maxAttempts: 10, cause: 'overloaded' },
        }),
      ]}
    />
  ),
}

/** Compaction in progress, and the marker it leaves in the transcript. */
export const Compaction: Story = {
  render: () => (
    <Frame
      parts={[
        text('t1', 'I have most of the context I need.'),
        durable({
          noticeId: 'n1',
          kind: 'compacted',
          message: 'Conversation compacted automatically',
          compaction: { trigger: 'auto', tokensBefore: 182_400, tokensAfter: 38_900 },
        }),
        text('t2', 'Picking up where we left off: the migration is next.'),
      ]}
    />
  ),
}

export const Compacting: Story = {
  render: () => (
    <Frame
      isStreaming
      parts={[live({ noticeId: 'n1', kind: 'compacting', message: 'Compacting the conversation' })]}
    />
  ),
}

/** Every durable notice kind, as they read between ordinary rows. */
export const DurableNotices: Story = {
  render: () => (
    <Frame
      parts={[
        durable({
          noticeId: 'n1',
          kind: 'model_fallback',
          message: 'Switched to claude-sonnet-5 after claude-opus-5 declined',
          model: { from: 'claude-opus-5', to: 'claude-sonnet-5' },
          detail: 'The request touched on a category the primary model declines by policy.',
        }),
        text('t1', 'Here is the summary you asked for.'),
        durable({
          noticeId: 'n2',
          kind: 'usage_warning',
          message: 'Approaching your 5-hour usage limit',
          resetsAt: inHours(2),
        }),
        durable({
          noticeId: 'n3',
          kind: 'warning',
          message: 'Settings file .claude/settings.json was ignored: invalid JSON',
        }),
        durable({ noticeId: 'n4', kind: 'info', message: 'Opus is unavailable; using Sonnet.' }),
        durable({
          noticeId: 'n5',
          kind: 'refusal',
          message: 'The model declined this request',
          detail:
            'This request appears to ask for help with something the usage policy does not allow.',
        }),
      ]}
    />
  ),
}

/** A failure after some work: the work folds, the failure and its action stay. */
export const Overloaded: Story = {
  render: () => (
    <Frame
      parts={[
        read('r1', 'src/index.ts'),
        failed({
          reason: 'overloaded',
          message: 'The provider is overloaded right now.',
          action: 'retry',
        }),
      ]}
    />
  ),
}

export const ContextWindowExceeded: Story = {
  render: () => (
    <Frame
      parts={[
        failed({
          reason: 'context_window_exceeded',
          message: "The conversation is too long for the model's context window.",
          action: 'compact',
        }),
      ]}
    />
  ),
}

export const UsageLimit: Story = {
  render: () => (
    <Frame
      parts={[
        failed({
          reason: 'usage_limit',
          message: "You've reached your usage limit.",
          resetsAt: inHours(3),
        }),
      ]}
    />
  ),
}

export const SignInRequired: Story = {
  render: () => (
    <Frame
      parts={[
        failed({
          reason: 'authentication_required',
          message: 'The provider requires authentication.',
          action: 'sign_in',
        }),
      ]}
    />
  ),
}

export const RateLimited: Story = {
  render: () => (
    <Frame
      parts={[
        failed({
          reason: 'rate_limited',
          message: 'The provider is rate limiting requests.',
          action: 'retry',
        }),
      ]}
    />
  ),
}

export const Refused: Story = {
  render: () => (
    <Frame parts={[failed({ reason: 'refused', message: 'The model declined this request.' })]} />
  ),
}

/** An older turn's failure keeps its guidance but offers no button. */
export const OlderFailure: Story = {
  render: () => (
    <Frame
      parts={[
        failed(
          {
            reason: 'overloaded',
            message: 'The provider is overloaded right now.',
            action: 'retry',
          },
          false,
        ),
      ]}
    />
  ),
}
