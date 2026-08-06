import type { Meta, StoryObj } from '@storybook/react-vite'
import { ThemeProvider } from '../../providers/theme-provider'
import { Markdown } from '../../components/markdown/Markdown'

const meta = {
  title: 'Markdown/Markdown',
  component: Markdown,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Markdown>

export default meta
type Story = StoryObj<typeof Markdown>

function Frame({ children }: { children: string }) {
  return (
    <ThemeProvider>
      <div className="min-h-screen bg-[var(--basis-canvas-bg)] p-10">
        <div className="mx-auto max-w-[720px]">
          <Markdown>{children}</Markdown>
        </div>
      </div>
    </ThemeProvider>
  )
}

const KITCHEN_SINK = `# Heading one sets the top of the scale

Body copy sits at 14px with a 1.75 line height. A second paragraph should have
real breathing room above it — not the 1px it used to get. Inline \`code\` gets a
chip, **strong** shifts color and weight, *emphasis* stays italic, and
~~strikethrough~~ goes faint. Here's an [external link](https://example.com).

## Heading two

### Heading three

#### Heading four

##### Heading five

Consecutive headings collapse their margins instead of compounding:

## Stacked heading A
### Stacked heading B

---

## Lists

- First bullet, with an actual disc marker
- Second bullet
  - Nested uses a circle
    - And a third level uses a square
- Back to the top level

1. Ordered items get tabular numerals
2. Second
   1. Nested ordered goes lower-alpha
      1. Then lower-roman
3. Third

- [ ] Unchecked task
- [x] Checked task with a themed box
- [ ] Another one

## Quotes

> A blockquote carries a two-pixel rule and muted text.
>
> Multiple paragraphs keep their spacing but the last one doesn't over-pad.

## Code

Inline \`const x = 1\` versus a fenced block:

\`\`\`tsx
export function Greeting({ name }: { name: string }) {
  const label = \`Hello, \${name}\`
  return <span className="greeting">{label}</span>
}
\`\`\`

\`\`\`python
def fib(n: int) -> int:
    a, b = 0, 1
    for _ in range(n):
        a, b = b, a + b
    return a
\`\`\`

\`\`\`bash
pnpm install && pnpm build --filter desktop
\`\`\`

A fence with no language should still render as a styled block:

\`\`\`
plain text, no grammar
\`\`\`

## Tables

| Provider | Streaming | Usage reported | Notes |
| --- | --- | --- | --- |
| Claude Code | yes | no | No thinking text emitted |
| Cursor | yes | no | Sends zero usage |
| OpenCode | yes | yes | totalTokens is cumulative |

## Soft line breaks

remark-breaks is on, so this line
and this line
render as three separate lines rather than one paragraph.
`

/** Every element the renderer supports, in one pass. */
export const KitchenSink: Story = {
  render: () => <Frame>{KITCHEN_SINK}</Frame>,
}

/** What a normal agent reply actually looks like. */
export const TypicalReply: Story = {
  render: () => (
    <Frame>{`I found the issue. The tooltip was bound to \`activeIndex\`, which defaults to \`0\`:

\`\`\`tsx
const activeModel = paneModels[activeIndex]
const metaRows = metaRowsFor(activeModel)
\`\`\`

So opening the picker always rendered a card for the first row. Three options:

1. Track a separate \`previewing\` flag — set on hover, cleared on mouse-leave
2. Use \`onMouseMove\` and derive from the event target
3. Move the card into each row and rely on \`:hover\`

I'd go with **option 1** — it keeps keyboard navigation working, which the
CSS-only approach can't do.

> Note: the pane switch also needs to reset the flag, or the card lingers.
`}</Frame>
  ),
}
