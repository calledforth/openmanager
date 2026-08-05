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

/** The size it actually ships at in the sidebar row. */
export const SidebarSize: Story = {
  render: () => (
    <ThemeProvider>
      <div className="flex items-center gap-2 bg-[var(--basis-canvas-bg)] p-6">
        <SessionBusyLoader className="h-4 w-4" />
        <span className="text-[13px] text-[var(--basis-text)]">Streaming bug fix</span>
      </div>
    </ThemeProvider>
  ),
}

/** Blown up to check the wave timing and cell spacing. */
export const Magnified: Story = {
  render: () => (
    <ThemeProvider>
      <div className="flex items-end gap-8 bg-[var(--basis-canvas-bg)] p-8">
        {[16, 24, 32, 48, 72].map((size) => (
          <div key={size} className="flex flex-col items-center gap-3">
            <SessionBusyLoader style={{ height: size, width: size }} />
            <span className="text-[10px] text-[var(--basis-text-faint)]">{size}px</span>
          </div>
        ))}
      </div>
    </ThemeProvider>
  ),
}
