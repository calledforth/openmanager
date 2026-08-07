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

/** Ships at 16×16, right-aligned in the session row. */
export const SidebarSize: Story = {
  render: () => (
    <ThemeProvider>
      <div className="flex w-72 flex-col gap-2 bg-[var(--basis-canvas-bg)] p-6">
        <div className="flex items-center gap-2 rounded-md bg-[var(--basis-surface-hover)] px-2 py-1">
          <span className="flex-1 truncate text-[13px] text-[var(--basis-text)]">
            Refactor the session runtime
          </span>
          <SessionBusyLoader tone="working" />
        </div>
        <div className="flex items-center gap-2 rounded-md bg-[var(--basis-surface-hover)] px-2 py-1">
          <span className="flex-1 truncate text-[13px] text-[var(--basis-text)]">
            Awaiting permission
          </span>
          <SessionBusyLoader tone="needs" />
        </div>
      </div>
    </ThemeProvider>
  ),
}

export const Magnified: Story = {
  render: () => (
    <ThemeProvider>
      <div className="flex flex-col items-start gap-6 bg-[var(--basis-canvas-bg)] p-8">
        {(['working', 'needs'] as const).map((tone) => (
          <div key={tone} className="flex flex-col gap-3">
            <span className="text-[11px] uppercase tracking-wide text-[var(--basis-text-faint)]">
              {tone}
            </span>
            <div className="flex items-end gap-4">
              {[16, 24, 40, 72].map((size) => (
                <div key={size} className="flex flex-col items-start gap-2">
                  <SessionBusyLoader tone={tone} style={{ height: size, width: size }} />
                  <span className="text-[10px] text-[var(--basis-text-faint)]">{size}px</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </ThemeProvider>
  ),
}
