import { useMemo } from 'react'
import { Palette } from 'lucide-react'
import {
  CommandMenu,
  CommandMenuDialog,
  CommandMenuEmpty,
  CommandMenuFooter,
  CommandMenuInput,
  CommandMenuList,
  type CommandMenuItemData,
} from '../fluid/ui/command-menu'
import { THEME_OPTIONS, useTheme } from '../../providers/theme-provider'

/**
 * ⌘K / Ctrl+K from anywhere. For now it only switches themes, the way Tend's
 * palette tries colour schemes: picking one leaves the palette open, so you
 * can step through them and watch the app change behind it.
 */
export function CommandPalette() {
  const { theme, setTheme } = useTheme()

  const items = useMemo<CommandMenuItemData[]>(
    () =>
      THEME_OPTIONS.map((option) => ({
        value: `theme:${option.id}`,
        label: option.label,
        description: option.hint,
        icon: Palette,
        group: 'Themes',
        action: option.id === theme ? 'Current' : 'Use',
        keywords: ['theme', 'colour', 'color', 'scheme', 'appearance', 'dark', 'light'],
        keepOpen: true,
        onSelect: () => setTheme(option.id),
      })),
    [theme, setTheme],
  )

  return (
    <CommandMenuDialog title="Search and commands">
      <CommandMenu items={items}>
        <CommandMenuInput placeholder="Search commands" />
        <CommandMenuList>
          <CommandMenuEmpty>Nothing matches.</CommandMenuEmpty>
        </CommandMenuList>
        <CommandMenuFooter />
      </CommandMenu>
    </CommandMenuDialog>
  )
}
