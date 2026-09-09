import type { Meta, StoryObj } from '@storybook/react-vite'
import { ChatViewPanel, AssistantMessage } from '../../components/chat/ChatViewPrimitives'

const meta = {
  title: 'App/ActivityGroup',
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
} satisfies Meta

export default meta
type Story = StoryObj

type Part = { type: string; id: string; [key: string]: unknown }

const edit = (id: string, path: string, added: number, removed: number): Part => ({
  type: 'tool',
  id,
  tool: 'Edit File',
  kind: 'edit',
  callID: id,
  state: {
    status: 'completed',
    input: { path },
    output: [
      ...Array.from({ length: added }, (_, index) => `+ added line ${index + 1}`),
      ...Array.from({ length: removed }, (_, index) => `- removed line ${index + 1}`),
    ].join('\n'),
  },
})

// Providers send a human-readable title plus the ACP kind, so the reads and
// searches below exercise the kind-based categorisation rather than the
// canonical-name shortcut.
const read = (id: string, path: string): Part => ({
  type: 'tool',
  id,
  tool: 'Read File',
  kind: 'read',
  callID: id,
  state: { status: 'completed', input: { path }, output: `contents of ${path}` },
})

const grep = (id: string, pattern: string): Part => ({
  type: 'tool',
  id,
  tool: 'Searched code',
  kind: 'search',
  callID: id,
  state: { status: 'completed', input: { pattern }, output: '3 matches' },
})

const bash = (id: string, command: string, status = 'completed'): Part => ({
  type: 'tool',
  id,
  tool: 'Run Terminal Command',
  kind: 'execute',
  callID: id,
  state: { status, input: { command }, output: status === 'completed' ? 'done' : '' },
})

const thinking = (id: string, text: string): Part => ({
  type: 'reasoning',
  id,
  text,
  time: { start: 1, end: 2400 },
})

function Frame({ parts, isStreaming }: { parts: Part[]; isStreaming?: boolean }) {
  return (
    <div className="h-screen w-screen bg-background">
      <ChatViewPanel>
        <div className="mx-auto max-w-2xl px-4 py-6">
          <AssistantMessage content="" isFinal={!isStreaming} parts={parts} />
        </div>
      </ChatViewPanel>
    </div>
  )
}

/** Mixed categories on one row, with summed diff stats. */
export const MixedRun: Story = {
  render: () => (
    <Frame
      parts={[
        edit('e1', 'src/main.ts', 3, 2),
        edit('e2', 'src/index.ts', 2, 3),
        read('r1', 'src/config.ts'),
        grep('g1', 'createServer'),
        bash('b1', 'pnpm test'),
        bash('b2', 'pnpm lint'),
        bash('b3', 'git status --short'),
        { type: 'text', id: 't1', text: 'Done. Here is what changed and what was verified.' },
      ]}
    />
  ),
}

/** Thinking breaks the run, so the tools group on either side of it. */
export const SplitByThinking: Story = {
  render: () => (
    <Frame
      parts={[
        thinking('th1', 'Adding convex to the catalog and pointing packages at it.'),
        edit('e1', 'package.json', 5, 5),
        edit('e2', 'pnpm-workspace.yaml', 2, 0),
        read('r1', 'packages/convex/package.json'),
        bash('b1', 'pnpm install'),
        thinking('th2', 'The CLI runs from the repo root and checks root package.json.'),
        edit('e3', 'apps/desktop/package.json', 5, 5),
        bash('b2', 'pnpm convex:dev'),
        bash('b3', 'pnpm typecheck'),
        { type: 'text', id: 't1', text: 'Done. Here is what changed and what was verified.' },
      ]}
    />
  ),
}

/** A failure stays on its own row rather than hiding inside a count. */
export const FailureBreaksOut: Story = {
  render: () => (
    <Frame
      parts={[
        read('r1', 'src/a.ts'),
        read('r2', 'src/b.ts'),
        {
          ...bash('b1', 'pnpm build'),
          state: { status: 'error', input: { command: 'pnpm build' }, error: 'exit code 1' },
        },
        read('r3', 'src/c.ts'),
        read('r4', 'src/d.ts'),
        { type: 'text', id: 't1', text: 'The build failed before I could continue.' },
      ]}
    />
  ),
}

/** A long thought is capped to a scroll area with a fade once you scroll into it. */
export const LongThinking: Story = {
  render: () => (
    <Frame
      parts={[
        {
          type: 'reasoning',
          id: 'th-long',
          text: Array.from(
            { length: 30 },
            (_, index) =>
              `Step ${index + 1}: weighing whether the grouping reducer should live in the shared package or the renderer.`,
          ).join('\n\n'),
          time: { start: 0, end: 14_000 },
        },
        read('r1', 'packages/shared/src/lib/activity-groups.ts'),
        read('r2', 'apps/desktop/src/renderer/src/components/parts/MessageParts.tsx'),
        { type: 'text', id: 't1', text: 'Shared package it is.' },
      ]}
    />
  ),
}

/** Reasoning without a transcript.
 *
 * Some providers stream thinking as text; others report only that a block ran
 * and roughly how many tokens it consumed — Claude Code's `thinking` blocks
 * carry an empty string and nothing else usable. Such a part renders as a plain
 * indicator row (there is nothing to expand), settled or still running, and the
 * turn reads as making progress instead of freezing for several seconds. The
 * middle row is a settled block whose count is genuinely zero: no token label,
 * but still a row. */
export const IndicatorOnlyThinking: Story = {
  render: () => (
    <Frame
      parts={[
        { type: 'reasoning', id: 'th-tokens', tokens: 1500, time: { start: 0, end: 2800 } },
        { type: 'reasoning', id: 'th-zero', tokens: 0, time: { start: 0, end: 300 } },
        read('r1', 'packages/agent-contract/src/events.ts'),
        { type: 'reasoning', id: 'th-live', tokens: 320, time: { start: 0 } },
        { type: 'text', id: 't1', text: 'Reasoning ran three times without saying a word.' },
      ]}
    />
  ),
}

/** A live run stays collapsed to one shimmering line that rewrites as calls land. */
export const Streaming: Story = {
  render: () => (
    <Frame
      isStreaming
      parts={[
        edit('e1', 'src/main.ts', 3, 1),
        edit('e2', 'src/index.ts', 1, 0),
        bash('b1', 'pnpm test', 'running'),
      ]}
    />
  ),
}
