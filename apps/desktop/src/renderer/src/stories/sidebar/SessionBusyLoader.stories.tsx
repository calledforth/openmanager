import type { Meta, StoryObj } from '@storybook/react-vite'
import { ThemeProvider } from '../../providers/theme-provider'
import { SessionBusyLoader } from '../../components/sidebar/SessionBusyLoader'

const meta = {
  title: 'App/SessionBusyLoader',
  component: SessionBusyLoader,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof SessionBusyLoader>

export default meta
type Story = StoryObj<typeof SessionBusyLoader>

/** The size it actually ships at: 48×16, right-aligned in the session row. */
export const SidebarSize: Story = {
  render: () => (
    <ThemeProvider>
      <div className="w-72 bg-[var(--basis-canvas-bg)] p-6">
        <div className="flex items-center gap-2 rounded-md bg-[var(--basis-surface-hover)] px-2 py-1">
          <span className="flex-1 truncate text-[13px] text-[var(--basis-text)]">
            Refactor the session runtime
          </span>
          <SessionBusyLoader className="h-4 w-12 shrink-0" />
        </div>
      </div>
    </ThemeProvider>
  ),
}

/** Blown up to check the chomp timing and that each pellet lands on an open mouth. */
export const Magnified: Story = {
  render: () => (
    <ThemeProvider>
      <div className="flex flex-col items-start gap-6 bg-[var(--basis-canvas-bg)] p-8">
        {[16, 24, 40, 72].map((height) => (
          <div key={height} className="flex flex-col items-start gap-2">
            <SessionBusyLoader style={{ height, width: height * 3 }} />
            <span className="text-[10px] text-[var(--basis-text-faint)]">{height}px tall</span>
          </div>
        ))}
      </div>
    </ThemeProvider>
  ),
}
