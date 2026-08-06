import type { Meta, StoryObj } from '@storybook/react-vite'
import { ThemeProvider } from '../../providers/theme-provider'
import { Tooltip } from '../../components/ui/Tooltip'

const meta = {
  title: 'UI/Tooltip',
  component: Tooltip,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof Tooltip>

export default meta
type Story = StoryObj<typeof Tooltip>

const demoButton =
  'flex h-7 items-center justify-center rounded-md border border-[var(--basis-border)] bg-[var(--basis-surface)] px-3 text-[11px] text-[var(--basis-text)] hover:bg-[var(--basis-surface-hover)]'

/** Every side, so the flip-on-no-room logic is easy to poke at near a viewport edge. */
export const Sides: Story = {
  render: () => (
    <ThemeProvider>
      <div className="grid grid-cols-2 gap-6 bg-[var(--basis-canvas-bg)] p-16">
        {(['top', 'bottom', 'left', 'right'] as const).map((side) => (
          <Tooltip key={side} content={`Opens on the ${side}`} side={side}>
            <button type="button" className={demoButton}>
              {side}
            </button>
          </Tooltip>
        ))}
      </div>
    </ThemeProvider>
  ),
}

/** With a key hint, and on a disabled control — the case native `title` handles badly. */
export const ShortcutAndDisabled: Story = {
  render: () => (
    <ThemeProvider>
      <div className="flex items-center gap-4 bg-[var(--basis-canvas-bg)] p-16">
        <Tooltip content="Send message" shortcut="⏎">
          <button type="button" className={demoButton}>
            Send
          </button>
        </Tooltip>
        <Tooltip content="This provider doesn't accept images">
          <button type="button" disabled className={`${demoButton} opacity-40`}>
            Attach
          </button>
        </Tooltip>
      </div>
    </ThemeProvider>
  ),
}

/** Long copy wraps at 260px rather than running off the edge. */
export const LongCopy: Story = {
  render: () => (
    <ThemeProvider>
      <div className="bg-[var(--basis-canvas-bg)] p-16">
        <Tooltip
          content="Plan revision feedback currently supports text only — drop the attachment or switch back to build mode."
          side="bottom"
        >
          <button type="button" className={demoButton}>
            Hover for a long tip
          </button>
        </Tooltip>
      </div>
    </ThemeProvider>
  ),
}
