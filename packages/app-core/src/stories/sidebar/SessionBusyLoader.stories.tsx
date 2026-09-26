import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { ThemeProvider } from '../../providers/theme-provider'
import { SessionBusyLoader, type SessionBusyTone } from '../../components/sidebar/SessionBusyLoader'

const meta = {
  title: 'App/SessionBusyLoader',
  component: SessionBusyLoader,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof SessionBusyLoader>

export default meta
type Story = StoryObj<typeof SessionBusyLoader>

const TONES = ['working', 'needs', 'done', 'error'] as const satisfies readonly SessionBusyTone[]

/** Ships at 8×8, right-aligned in the session card. Needs also gets a
 * trailing amber dither on the card. */
export const SidebarSize: Story = {
  render: () => (
    <ThemeProvider>
      <div className="flex w-72 flex-col gap-2 bg-[var(--basis-canvas-bg)] p-6">
        {TONES.map((tone) => (
          <div
            key={tone}
            className="relative flex items-center gap-2 overflow-hidden rounded-md bg-[var(--basis-surface-hover)] px-2 py-1"
          >
            {tone === 'needs' ? (
              <span aria-hidden="true" className="session-row-dither session-row-dither--needs" />
            ) : null}
            <span className="relative flex-1 truncate text-[13px] text-[var(--basis-text)]">
              {tone}
            </span>
            <SessionBusyLoader tone={tone} className="relative z-[1]" />
          </div>
        ))}
      </div>
    </ThemeProvider>
  ),
}

export const Magnified: Story = {
  render: () => (
    <ThemeProvider>
      <div className="flex flex-col items-start gap-6 bg-[var(--basis-canvas-bg)] p-8">
        {TONES.map((tone) => (
          <div key={tone} className="flex flex-col gap-3">
            <span className="text-[11px] uppercase tracking-wide text-[var(--basis-text-faint)]">
              {tone}
            </span>
            <div className="flex items-end gap-4">
              {[12, 24, 40, 72].map((size) => (
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

/** Switch tones to see the transitions; finishing throws the spark burst. */
export const Transitions: Story = {
  render: function Render() {
    const [tone, setTone] = useState<SessionBusyTone>('working')
    const [burst, setBurst] = useState<number>()
    const go = (next: SessionBusyTone) => {
      setTone(next)
      setBurst(next === 'done' ? Date.now() : undefined)
    }
    return (
      <ThemeProvider>
        <div className="flex flex-col items-center gap-6 bg-[var(--basis-canvas-bg)] p-10">
          <SessionBusyLoader
            tone={tone}
            burst={burst}
            className={tone === 'error' ? 'session-busy-ring--moment' : undefined}
            style={{ transform: 'scale(3)' }}
          />
          <div className="flex gap-2">
            {TONES.map((next) => (
              <button
                key={next}
                type="button"
                onClick={() => go(next)}
                className="rounded-md bg-[var(--basis-surface-hover)] px-2 py-1 text-[12px] text-[var(--basis-text)]"
              >
                {next}
              </button>
            ))}
          </div>
        </div>
      </ThemeProvider>
    )
  },
}
