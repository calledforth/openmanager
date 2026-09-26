import type { Meta, StoryObj } from '@storybook/react-vite'
import {
  ArrowsLeftRightIcon,
  CheckIcon,
  CpuIcon,
  PencilSimpleIcon,
  PlusIcon,
  TrashIcon,
} from '@phosphor-icons/react'
import { phosphorIcon } from '../../components/fluid/lib/icon-context'
import { ThemeProvider } from '../../providers/theme-provider'
import {
  CommandPalette,
  CommandPaletteView,
  type CommandPaletteItemData,
} from '../../components/command/CommandPalette'

/** Session commands the palette could run with a session open, as Linear's
 *  palette runs issue commands on the chip's issue. Display only here. */
const SESSION_ITEMS: CommandPaletteItemData[] = [
  { value: 'new', label: 'New agent', icon: phosphorIcon(PlusIcon), shortcut: 'N' },
  { value: 'settle', label: 'Settle session', icon: phosphorIcon(CheckIcon), shortcut: 'S' },
  { value: 'rename', label: 'Rename…', icon: phosphorIcon(PencilSimpleIcon), shortcut: 'R' },
  { value: 'model', label: 'Change model…', icon: phosphorIcon(CpuIcon), shortcut: 'M' },
  { value: 'mode', label: 'Switch to Plan mode', icon: phosphorIcon(ArrowsLeftRightIcon), shortcut: 'shift+tab' },
  { value: 'delete', label: 'Delete session…', icon: phosphorIcon(TrashIcon), shortcut: 'mod+backspace' },
]

/** A stand-in page, so the scrim and the shadow have something to sit on. */
function Backdrop() {
  return (
    <div className="flex h-svh bg-background text-foreground">
      <div className="w-[260px] shrink-0 space-y-2 p-4">
        {['Inbox', 'Fix websocket reconnect', 'Sidebar settle', 'Composer drafts'].map((label) => (
          <div key={label} className="rounded-md px-2 py-1.5 text-[13px] text-muted-foreground">
            {label}
          </div>
        ))}
      </div>
      <div className="flex-1 space-y-3 bg-[var(--basis-canvas-bg)] p-8">
        {Array.from({ length: 9 }, (_, i) => (
          <div key={i} className="flex items-center gap-3 text-[13px]">
            <span className="w-14 text-muted-foreground">CAL-{80 + i}</span>
            <span>Implement debounced draft autosave, part {i + 1}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

const meta = {
  title: 'App/CommandPalette',
  parameters: { layout: 'fullscreen' },
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

export const SessionCommands: Story = {
  render: () => (
    <ThemeProvider>
      <Backdrop />
      <CommandPaletteView
        defaultOpen
        shortcut={null}
        items={SESSION_ITEMS}
        context={{ prefix: 'openmanager', label: 'Fix websocket reconnect' }}
      />
    </ThemeProvider>
  ),
}

/** The live palette: themes and fonts, picked in place. */
export const ThemesAndFonts: Story = {
  render: () => (
    <ThemeProvider>
      <Backdrop />
      <OpenOnMount />
    </ThemeProvider>
  ),
}

function OpenOnMount() {
  // The live palette binds ⌘K itself; the story presses it once.
  const mac = /Mac|iPhone|iPad/.test(navigator.platform)
  return (
    <div
      ref={(node) => {
        if (!node) return
        requestAnimationFrame(() =>
          window.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'k', ctrlKey: !mac, metaKey: mac }),
          ),
        )
      }}
    >
      <CommandPalette />
    </div>
  )
}
