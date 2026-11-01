import type { Meta, StoryObj } from '@storybook/react-vite'
import type { ReactNode } from 'react'
import { ToolRow, type ToolRowPart } from '../../components/parts/ToolRow'

const meta = {
  title: 'App/ToolRows',
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
} satisfies Meta

export default meta
type Story = StoryObj

let next = 0
const row = (
  fields: Partial<ToolRowPart>,
  status = 'completed',
  input?: unknown,
  output?: string,
) =>
  ({
    type: 'tool',
    id: `tool-${(next += 1)}`,
    tool: fields.toolName ?? fields.title ?? 'tool',
    ...fields,
    state: { status, ...(input ? { input } : {}), ...(output ? { output } : {}) },
  }) as ToolRowPart

const time = (ms: number) => ({ time: { start: 0, end: ms } })

function Rows({ title, parts }: { title: string; parts: ToolRowPart[] }): ReactNode {
  return (
    <section className="mb-6">
      <h3 className="text-ui-sm mb-1.5 text-[var(--basis-text-faint)]">{title}</h3>
      <div className="flex flex-col gap-0.5">
        {parts.map((part) => (
          <ToolRow key={part.id} part={part} />
        ))}
      </div>
    </section>
  )
}

const Page = ({ children }: { children: ReactNode }) => (
  <div className="mx-auto max-w-[720px] bg-[var(--basis-canvas-bg)] p-6">{children}</div>
)

const Claude = () => (
  <Rows
    title="Claude Code"
    parts={[
      row({ toolName: 'Bash', ...time(2_400), outputBytes: 1_900 }, 'completed', {
        command: 'pnpm --filter @openmanager/server test',
        description: 'Run the server tests',
      }),
      row(
        { toolName: 'Bash' },
        'running',
        { command: 'pnpm build' },
        'building packages/protocol\n',
      ),
      row(
        { toolName: 'Read', locations: [{ path: 'apps/server/src/thread-service.ts' }] },
        'completed',
        {
          file_path: 'apps/server/src/thread-service.ts',
        },
      ),
      row({ toolName: 'Edit', lineChanges: { added: 12, removed: 3 } }, 'completed', {
        file_path: 'packages/protocol/src/domains.ts',
      }),
      row({ toolName: 'Write', lineChanges: { added: 48, removed: 0 } }, 'completed', {
        file_path: 'packages/protocol/src/tool-state.ts',
      }),
      row({ toolName: 'Grep', outputBytes: 840 }, 'completed', {
        pattern: 'applyToolUpdate',
        path: 'packages',
      }),
      row({ toolName: 'Glob', outputBytes: 210 }, 'completed', { pattern: '**/*.stories.tsx' }),
      row({ toolName: 'WebSearch', outputBytes: 2_900 }, 'completed', {
        query: 'websocket permessage-deflate cloudflare',
      }),
      row({ toolName: 'WebFetch', outputBytes: 1_300 }, 'completed', {
        url: 'https://developers.cloudflare.com/workers/runtime-apis/websockets/',
      }),
      row({ toolName: 'Agent', outputBytes: 1_100 }, 'completed', {
        description: 'Audit the sync layer',
        prompt: 'Read the event log code.',
      }),
      row({ toolName: 'mcp__claude_ai_Linear__list_issues', outputBytes: 2_000 }, 'completed', {
        query: 'sync',
      }),
    ]}
  />
)

const Cursor = () => (
  <Rows
    title="Cursor"
    parts={[
      row({ title: '`git status`', kind: 'execute', outputBytes: 320 }, 'completed', {
        command: 'git status',
      }),
      row({ title: 'Read src/app/layout.tsx (1 - 40)', kind: 'read' }),
      row({ title: 'Read File', kind: 'read' }),
      row({
        title: 'Edit `src/components/page/top-bar.tsx`',
        kind: 'edit',
        locations: [{ path: 'src/components/page/top-bar.tsx' }],
      }),
      row({ title: 'Edit File', kind: 'edit', locations: [{ path: 'C:/work/notes.md' }] }),
      row({ title: 'Delete `src/old.tsx`', kind: 'delete' }),
      row({ title: 'grep --include="*.ts" "mode capabilities"', kind: 'search', outputBytes: 10 }),
      row({ title: 'grep', toolName: 'grep', kind: 'search', outputBytes: 10 }),
      row({ title: 'Find `*.txt`', kind: 'search', outputBytes: 7 }),
      row({ title: "List the `src` directory's contents", kind: 'search' }),
      row({ title: 'Search: "where sessions resume"', kind: 'search', outputBytes: 9 }),
      row({ title: 'Web Search: "agent client protocol"', kind: 'search', outputBytes: 11 }),
      row({ title: 'Web Fetch: https://example.com/spec', kind: 'fetch' }),
      row({ title: 'Task: Summarize the folder', toolName: 'task', kind: 'other' }),
      row({ title: 'Update TODOs: Fix the tests', toolName: 'updateTodos', kind: 'other' }),
      row({ title: 'linear: list_issues', kind: 'other' }, 'completed', {
        providerIdentifier: 'linear',
        toolName: 'list_issues',
      }),
    ]}
  />
)

const OpenCode = () => (
  <Rows
    title="OpenCode"
    parts={[
      row(
        { toolName: 'bash', title: 'Runs the unit tests', kind: 'execute', outputBytes: 600 },
        'completed',
        {
          command: 'bun test',
          description: 'Runs the unit tests',
        },
      ),
      row({ toolName: 'read', title: 'src/index.ts', kind: 'read' }, 'completed', {
        filePath: 'src/index.ts',
      }),
      row({ toolName: 'edit', title: 'src/index.ts', kind: 'edit' }, 'completed', {
        filePath: 'src/index.ts',
      }),
      row({
        toolName: 'apply_patch',
        title: 'Patched 2 files',
        kind: 'edit',
        locations: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }],
      }),
      row({ toolName: 'grep', title: 'TODO', kind: 'search', outputBytes: 320 }, 'completed', {
        pattern: 'TODO',
        path: 'src',
      }),
      row({ toolName: 'glob', title: '*.ts', kind: 'search', outputBytes: 90 }, 'completed', {
        pattern: '*.ts',
      }),
      row({ toolName: 'list', title: 'src', kind: 'read', outputBytes: 70 }, 'completed', {
        path: 'src',
      }),
      row(
        { toolName: 'webfetch', title: 'https://example.com', kind: 'fetch', outputBytes: 900 },
        'completed',
        { url: 'https://example.com' },
      ),
      row(
        { toolName: 'task', title: 'Summarize folder structure', kind: 'think', outputBytes: 400 },
        'completed',
        {
          description: 'Summarize folder structure',
        },
      ),
    ]}
  />
)

const Outcomes = () => (
  <Rows
    title="How calls end"
    parts={[
      row({ toolName: 'Bash', outputBytes: 90, ...time(3_100) }, 'error', { command: 'pnpm test' }),
      row({ toolName: 'Bash' }, 'declined', { command: 'rm -rf build' }),
      row({ toolName: 'Bash', outputBytes: 400 }, 'cancelled', { command: 'pnpm dev' }),
      row({ toolName: 'Edit', outputBytes: 42 }, 'error', { file_path: 'src/missing.ts' }),
      row({ toolName: 'Read' }, 'pending', { file_path: 'src/index.ts' }),
    ]}
  />
)

export const AllProviders: Story = {
  render: () => (
    <Page>
      <Claude />
      <Cursor />
      <OpenCode />
      <Outcomes />
    </Page>
  ),
}

export const Opened: Story = {
  render: () => (
    <Page>
      <Rows
        title="Opened"
        parts={[
          row(
            { toolName: 'Bash' },
            'running',
            {
              command: 'pnpm test --filter server\n  --reporter=verbose',
            },
            ' RUN  v4.0.18\n ✓ tests/replay.test.ts (24 tests)\n ✓ tests/websocket.test.ts (61 tests)\n',
          ),
        ]}
      />
    </Page>
  ),
  play: async ({ canvasElement }) => {
    for (const details of canvasElement.querySelectorAll('details')) details.open = true
  },
}
