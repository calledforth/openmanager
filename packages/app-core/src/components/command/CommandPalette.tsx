import { useMemo, type ReactNode } from 'react'
import { CheckIcon, PaletteIcon, TextTIcon } from '@phosphor-icons/react'
import {
  CommandMenu,
  CommandMenuChip,
  CommandMenuDialog,
  CommandMenuEmpty,
  CommandMenuInput,
  CommandMenuItem,
  CommandMenuList,
  type CommandMenuItemData,
} from '../fluid/ui/command-menu'
import { phosphorIcon } from '../fluid/lib/icon-context'
import { UI_FONTS } from '../../lib/fonts'
import { THEME_OPTIONS, useTheme } from '../../providers/theme-provider'

/** A palette row. `current` marks the option already in effect with a check
 *  at the trailing edge, where Linear keeps its key caps. */
export type CommandPaletteItemData = CommandMenuItemData & { current?: boolean }

export interface CommandPaletteViewProps {
  items: readonly CommandPaletteItemData[]
  /** What the commands act on, shown as a chip above the field. */
  context?: { prefix?: ReactNode; label: ReactNode }
  placeholder?: string
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  /** @default "mod+k" */
  shortcut?: string | null
}

/**
 * The palette's look, after Linear's: a floating card with no outline, no
 * divider under the field and no hint strip, tall rows whose highlight is a
 * soft fill.
 */
export function CommandPaletteView({
  items,
  context,
  placeholder = 'Type a command or search…',
  open,
  defaultOpen,
  onOpenChange,
  shortcut,
}: CommandPaletteViewProps) {
  return (
    <CommandMenuDialog
      title="Search and commands"
      open={open}
      defaultOpen={defaultOpen}
      onOpenChange={onOpenChange}
      shortcut={shortcut}
      className="max-w-[640px]"
    >
      <CommandMenu items={items}>
        {context && <CommandMenuChip prefix={context.prefix}>{context.label}</CommandMenuChip>}
        <CommandMenuInput icon={null} placeholder={placeholder} className="text-[15px] leading-6" />
        <CommandMenuList
          className="gap-0 px-1.5 pb-1.5 pt-0.5"
          renderItem={(item) => <CommandPaletteItem item={item} />}
        >
          <CommandMenuEmpty>Nothing matches.</CommandMenuEmpty>
        </CommandMenuList>
      </CommandMenu>
    </CommandMenuDialog>
  )
}

/** Rows a notch taller and larger than the menu's default, as in Linear. */
function CommandPaletteItem({ item }: { item: CommandPaletteItemData }) {
  return (
    // Every row reads at full strength, as in Linear; the fill alone says
    // which one Enter runs. Key caps come from the item's `shortcut`.
    <CommandMenuItem
      value={item.value}
      className="h-11 gap-3 px-3 text-[14px] text-foreground [&>svg:first-child]:text-muted-foreground"
    >
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className="truncate">{item.label}</span>
        {item.description && (
          <span className="min-w-0 truncate text-muted-foreground/70">{item.description}</span>
        )}
      </span>
      {item.current && (
        <CheckIcon aria-label="Current" className="h-4 w-4 shrink-0 text-foreground" />
      )}
    </CommandMenuItem>
  )
}

const ThemeIcon = phosphorIcon(PaletteIcon)
const FontIcon = phosphorIcon(TextTIcon)

/**
 * ⌘K / Ctrl+K from anywhere. For now it switches themes and fonts, the way
 * Tend's palette tries colour schemes: picking one leaves the palette open, so
 * you can step through them and watch the app change behind it.
 */
export function CommandPalette() {
  const { theme, setTheme, font, setFont } = useTheme()

  const items = useMemo<CommandPaletteItemData[]>(
    () => [
      ...THEME_OPTIONS.map((option) => ({
        value: `theme:${option.id}`,
        label: option.label,
        description: option.hint,
        icon: ThemeIcon,
        group: 'Themes',
        current: option.id === theme,
        keywords: ['theme', 'colour', 'color', 'scheme', 'appearance', 'dark', 'light'],
        keepOpen: true,
        onSelect: () => setTheme(option.id),
      })),
      ...UI_FONTS.map((option) => ({
        value: `font:${option.id}`,
        label: option.label,
        icon: FontIcon,
        group: 'Fonts',
        current: option.id === font,
        keywords: ['font', 'typeface', 'type', 'text'],
        keepOpen: true,
        onSelect: () => setFont(option.id),
      })),
    ],
    [theme, setTheme, font, setFont],
  )

  return <CommandPaletteView items={items} />
}
