import type { Meta, StoryObj } from '@storybook/react-vite'
import {
  ChatViewPanel,
  UserMessage,
  AssistantMessage,
} from '../../components/chat/ChatViewPrimitives'

const meta = {
  title: 'App/ChatViewPrimitives',
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
} satisfies Meta

export default meta
type Story = StoryObj

// ─── Realistic assistant reply with code, table, list ───────────────────────

const TYPOGRAPHY_REPLY = `I've applied four typography changes to the renderer. Here's a summary of what changed and why each matters.

## What Changed

### 1. Self-hosted variable font

Inter is now loaded via \`@fontsource-variable/inter\` instead of the Google Fonts CDN. The variable font covers the full weight axis \`100–900\` in a single \`.woff2\`.

\`\`\`css
/* before */
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700');

/* after */
@import "@fontsource-variable/inter";
\`\`\`

### 2. Geometric glyphs via ss03

Inter's Stylistic Set 03 swaps the default humanist letterforms for geometric alternatives on \`a\`, \`g\`, \`l\`, and \`t\`. Enabled globally on \`html\`.

\`\`\`css
html {
  font-feature-settings: "ss03" 1;
}
\`\`\`

### 3. Named type scale

| Class | Size | Weight | Line height |
|-------|------|--------|-------------|
| \`.text-13-regular\` | 13px | 400 | 1.5 |
| \`.text-14-regular\` | 14px | 400 | 1.8 |
| \`.text-14-medium\` | 14px | 500 | 1.5 |
| \`.text-20-medium\` | 20px | 500 | 1.8 |

### 4. Line-height tokens

Three tokens replaced \`leading-relaxed\` (1.625):

- \`--lh-tight: 1.3\` — compact UI rows, tool call headers
- \`--lh-default: 1.5\` — base body, user messages, sidebar items
- \`--lh-loose: 1.8\` — assistant prose, markdown paragraphs
`

const STREAMING_REPLY = `The flicker is caused by component remounting when the parts array reference changes identity on each chunk.

The root issue is in how React reconciles keyed lists — if the \`key\` prop on a tool-call component is derived from array index rather than the part's stable \`id\`, every insertion at the beginning of the list forces a full re-render of all subsequent items.

**Fix:** key every part by \`part.id\`, not index:

\`\`\`tsx
{parts.map((part) => (
  <PartRenderer key={part.id} part={part} />
))}
\`\`\`

This is a one-line change. No state is lost once the key is stable.`

// ─── Stories ─────────────────────────────────────────────────────────────────

export const StaticConversation: Story = {
  render: () => (
    <div className="h-screen w-screen bg-background flex flex-col">
      <ChatViewPanel>
        <div className="flex-1 overflow-y-auto overflow-x-hidden min-h-0">
          <div className="mx-auto max-w-2xl px-4 py-6 space-y-1">
            <UserMessage
              content="Why does the font look generic even though we use Inter?"
              runtime={{ modelId: 'claude-sonnet-4-5', modeId: 'plan', tokens: { total: 221 } }}
            />
            <AssistantMessage
              isFinal={true}
              content={TYPOGRAPHY_REPLY}
              runtime={{
                providerId: 'anthropic',
                modelId: 'claude-sonnet-4-5',
                tokens: { total: 918 },
              }}
            />
            <UserMessage content="Can you show me the flicker fix for tool calls during streaming?" />
            <AssistantMessage
              isFinal={true}
              content={STREAMING_REPLY}
              runtime={{
                providerId: 'anthropic',
                modelId: 'claude-sonnet-4-5',
                modeId: 'default',
                tokens: { total: 312 },
              }}
            />
          </div>
        </div>
      </ChatViewPanel>
    </div>
  ),
}

export const StreamingInProgress: Story = {
  render: () => (
    <div className="h-screen w-screen bg-background flex flex-col">
      <ChatViewPanel>
        <div className="flex-1 overflow-y-auto overflow-x-hidden min-h-0">
          <div className="mx-auto max-w-2xl px-4 py-6 space-y-1">
            <UserMessage
              content="Apply the four font changes we identified: variable font, ss03, type scale, and line-height tokens."
              runtime={{ modelId: 'claude-sonnet-4-5', modeId: 'plan', tokens: { total: 44 } }}
            />
            <AssistantMessage
              isFinal={false}
              content={`I've applied four typography changes to the renderer. Here's a summary of what changed and why each matters.

## What Changed

### 1. Self-hosted variable font

Inter is now loaded via \`@fontsource-variable/inter\` instead of the Google Fonts CDN.`}
              runtime={{ providerId: 'anthropic', modelId: 'claude-sonnet-4-5', modeId: 'plan' }}
            />
          </div>
        </div>
      </ChatViewPanel>
    </div>
  ),
}

export const ErrorState: Story = {
  render: () => (
    <div className="h-screen w-screen bg-background flex flex-col">
      <ChatViewPanel>
        <div className="flex-1 overflow-y-auto overflow-x-hidden min-h-0">
          <div className="mx-auto max-w-2xl px-4 py-6 space-y-1">
            <UserMessage content="Run typecheck and fix any errors." />
            <AssistantMessage
              isFinal={true}
              content={`I hit a type error in \`ChatViewPrimitives.tsx\` at line 105. The \`cn()\` call has a conditional that widens to \`string | false\`, but the type expects \`string\`. I attempted to write a fix but the file was locked by the editor. Please close the file and retry.`}
              runtime={{
                providerId: 'anthropic',
                modelId: 'claude-sonnet-4-5',
                finishReason: 'error',
                tokens: { total: 78 },
              }}
            />
          </div>
        </div>
      </ChatViewPanel>
    </div>
  ),
}
