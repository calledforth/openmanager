import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
} from 'react'
import { createPortal } from 'react-dom'
import { CaretDownIcon, CheckIcon, SquaresFourIcon, StarIcon } from '@phosphor-icons/react'
import type { ProviderId, SessionConfigOption } from '@agentpack/contract'
import { cn } from '../../lib/utils'
import {
  CommandMenu,
  CommandMenuEmpty,
  CommandMenuInput,
  CommandMenuItem,
  CommandMenuList,
  CommandMenuShortcut,
  CommandMenuTabs,
  matchesShortcut,
  parseShortcut,
  type CommandMenuItemData,
  type CommandMenuTab,
} from '../fluid/ui/command-menu'
import { phosphorIcon, type IconComponentProps } from '../fluid/lib/icon-context'
import { composerChip } from './chatComposerStyles'
import { ProviderIcon } from '../providers/ProviderIcon'
import { Tooltip } from '../ui/Tooltip'
import { usePortaledMenu } from '../ui/usePortaledMenu'
import { useHoldFocus, useRegisterPicker } from '../command/pickerRegistry'
import { modelHint, modelLabel } from './modelLabel'
import { contextWindowConfigOption, effortConfigOption } from './modelConfig'
import {
  favoriteModelKey,
  readFavoriteModels,
  toggleFavoriteModel,
  writeFavoriteModels,
  type FavoriteModelKey,
} from './favoriteModels'

export type ProviderModelOption = {
  id: string
  name: string
  description?: string
  resolvedModel?: string
  effortLevels?: string[]
  supportsFastMode?: boolean
  supportsAutoMode?: boolean
  contextWindowTokens?: number
  configOptions?: SessionConfigOption[]
}

export type ProviderModelGroup = {
  providerId: ProviderId
  providerName: string
  models: ProviderModelOption[]
  /** Why this provider cannot be switched to right now. Its models stay
   * listed, so the picker says what is wrong instead of hiding the provider. */
  unavailableReason?: string
}

/** Tab order after All and Favorites. */
const PROVIDER_ORDER: readonly ProviderId[] = ['claude', 'cursor', 'opencode']

const ALL_SCOPE = 'all'
const FAVORITES_SCOPE = 'favorites'
type Scope = typeof ALL_SCOPE | typeof FAVORITES_SCOPE | ProviderId

const MENU_WIDTH = 440
/** Favorites past this many have no Alt+digit key. */
const FAVORITE_KEYS = 9

type FlatModel = {
  key: FavoriteModelKey
  providerId: ProviderId
  providerName: string
  modelId: string
  label: string
  description?: string
  resolvedModel?: string
  effortLevels?: string[]
  supportsFastMode?: boolean
  contextWindowTokens?: number
  configOptions?: SessionConfigOption[]
  unavailableReason?: string
}

type MetaRow = { label: string; value: string }

const AllIcon = phosphorIcon(SquaresFourIcon)
const FavoritesIcon = phosphorIcon(StarIcon)

/** One stable icon component per provider, for the tabs. */
const providerTabIcons = new Map<ProviderId, (props: IconComponentProps) => ReactElement>()
function providerTabIcon(providerId: ProviderId) {
  let icon = providerTabIcons.get(providerId)
  if (!icon) {
    icon = function ProviderTabIcon({ className }: IconComponentProps) {
      return <ProviderIcon providerId={providerId} className={cn('h-3.5 w-3.5', className)} />
    }
    providerTabIcons.set(providerId, icon)
  }
  return icon
}

function sortGroups(groups: ProviderModelGroup[]): ProviderModelGroup[] {
  const rank = new Map(PROVIDER_ORDER.map((id, index) => [id, index]))
  return [...groups].sort((a, b) => (rank.get(a.providerId) ?? 99) - (rank.get(b.providerId) ?? 99))
}

/** "1M", "200k": short enough to sit at a row's edge. */
function formatContextShort(tokens: number): string {
  if (tokens >= 1_000_000) return `${+(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`
  return String(tokens)
}

const range = (values: readonly string[]) => {
  const first = values[0]
  const last = values[values.length - 1]
  return first === last ? first : `${first}–${last}`
}

/** What the hover card says about a model, from whatever its catalog row
 * carries. Rows that know nothing about a setting leave it out rather than
 * claim "not supported" for a provider that never said. */
function metaRowsFor(model: FlatModel | undefined): MetaRow[] | null {
  if (!model) return null
  const options = model.configOptions
  const rows: MetaRow[] = [
    { label: 'Model', value: model.label },
    { label: 'Provider', value: model.providerName },
  ]

  if (model.resolvedModel) {
    rows.push({ label: 'Resolves to', value: model.resolvedModel })
  }

  const effort = effortConfigOption(options)
  if (effort) {
    rows.push({ label: 'Reasoning', value: range(effort.options.map((option) => option.name)) })
  } else if (model.effortLevels?.length) {
    rows.push({ label: 'Reasoning', value: range(model.effortLevels) })
  } else if (options || model.providerId === 'claude') {
    rows.push({ label: 'Reasoning', value: 'No effort control' })
  }

  const context = contextWindowConfigOption(options)
  if (context) {
    rows.push({
      label: 'Context',
      value: context.options.map((option) => option.name.toUpperCase()).join(' or '),
    })
  } else if (model.contextWindowTokens) {
    rows.push({ label: 'Context', value: formatContextShort(model.contextWindowTokens) })
  }

  const fast = options?.find((option) => /^fast(_mode)?$/i.test(option.id))
  if (fast || model.supportsFastMode) {
    rows.push({ label: 'Fast mode', value: 'Supported' })
  } else if (options || model.providerId === 'claude') {
    rows.push({ label: 'Fast mode', value: 'Not supported' })
  }

  if (model.description) {
    rows.push({ label: 'Notes', value: model.description })
  }

  return rows.length > 2 ? rows : null
}

/**
 * The composer's provider→model picker: a command menu anchored to its chip.
 * Search on top, provider tabs under it (Tab and ← → step through them), the
 * current model highlighted on open. ⌘S / Ctrl+S stars the highlighted
 * model and Alt+1…9 picks a favorite outright.
 */
export function ProviderModelPicker({
  groups,
  currentProviderId,
  currentModelId,
  onChange,
  disabled,
  canChangeProvider,
  shortcut,
  onDone,
}: {
  groups: ProviderModelGroup[]
  currentProviderId: ProviderId
  currentModelId: string
  onChange: (providerId: ProviderId, modelId: string) => void
  disabled?: boolean
  canChangeProvider: boolean
  /** Opens (and closes) the picker from anywhere, e.g. `"mod+shift+m"`. */
  shortcut?: string
  /** Runs when the picker closes from the keyboard or a pick, so the host can
   *  hand focus back (the composer's textarea). Not on an outside click. */
  onDone?: () => void
}) {
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<Scope>(ALL_SCOPE)
  const [favorites, setFavorites] = useState<FavoriteModelKey[]>(() => readFavoriteModels())
  const [highlighted, setHighlighted] = useState<FavoriteModelKey | null>(null)
  // The detail card is a pointing/browsing affordance: it appears once the
  // user points at or arrows to a row, never for the row highlighted on open.
  const [previewing, setPreviewing] = useState(false)
  const [cardTop, setCardTop] = useState<number | null>(null)

  const visibleGroups = useMemo(() => {
    const filtered = canChangeProvider
      ? groups.filter((group) => group.models.length > 0)
      : groups.filter((group) => group.providerId === currentProviderId && group.models.length > 0)
    return sortGroups(filtered)
  }, [canChangeProvider, currentProviderId, groups])

  const allModels = useMemo<FlatModel[]>(
    () =>
      visibleGroups.flatMap((group) =>
        group.models.map((model) => {
          const label = modelLabel(model.name, model.description)
          const description = modelHint(model.name, model.description)
          return {
            key: favoriteModelKey(group.providerId, model.id),
            providerId: group.providerId,
            providerName: group.providerName,
            modelId: model.id,
            label,
            ...(description ? { description } : {}),
            ...(model.resolvedModel ? { resolvedModel: model.resolvedModel } : {}),
            ...(model.effortLevels?.length ? { effortLevels: model.effortLevels } : {}),
            ...(model.supportsFastMode ? { supportsFastMode: true } : {}),
            ...(model.contextWindowTokens
              ? { contextWindowTokens: model.contextWindowTokens }
              : {}),
            ...(model.configOptions ? { configOptions: model.configOptions } : {}),
            ...(group.unavailableReason ? { unavailableReason: group.unavailableReason } : {}),
          }
        }),
      ),
    [visibleGroups],
  )
  const modelsByKey = useMemo(
    () => new Map(allModels.map((model) => [model.key, model])),
    [allModels],
  )

  const favoriteModels = useMemo(
    () =>
      favorites
        .map((key) => modelsByKey.get(key))
        .filter((model): model is FlatModel => model !== undefined),
    [favorites, modelsByKey],
  )
  const favoriteNumber = useMemo(
    () => new Map(favoriteModels.slice(0, FAVORITE_KEYS).map((model, i) => [model.key, i + 1])),
    [favoriteModels],
  )

  // Tabs only earn their row when there is more than one place to go.
  const tabs = useMemo<CommandMenuTab[]>(() => {
    if (visibleGroups.length < 2) return []
    return [
      { value: ALL_SCOPE, label: 'All', icon: AllIcon },
      { value: FAVORITES_SCOPE, label: 'Favorites', icon: FavoritesIcon },
      ...visibleGroups.map((group) => ({
        value: group.providerId,
        label: group.providerName,
        icon: providerTabIcon(group.providerId),
      })),
    ]
  }, [visibleGroups])
  const activeScope: Scope = tabs.some((tab) => tab.value === scope) ? scope : ALL_SCOPE

  const items = useMemo<CommandMenuItemData[]>(() => {
    const scoped =
      activeScope === FAVORITES_SCOPE
        ? favoriteModels
        : activeScope === ALL_SCOPE
          ? allModels
          : allModels.filter((model) => model.providerId === activeScope)
    // Headings only where rows from several providers share the list.
    const grouped = activeScope === ALL_SCOPE && visibleGroups.length > 1
    return scoped.map((model) => ({
      value: model.key,
      label: model.label,
      // An unavailable provider's rows say why in place of their hint.
      ...((model.unavailableReason ?? model.description)
        ? { description: model.unavailableReason ?? model.description }
        : {}),
      keywords: [model.providerName, model.providerId, model.modelId],
      ...(grouped ? { group: model.providerName } : {}),
      ...(model.unavailableReason ? { disabled: true } : {}),
    }))
  }, [activeScope, allModels, favoriteModels, visibleGroups.length])

  const currentGroup = groups.find((group) => group.providerId === currentProviderId)
  const currentModel =
    currentGroup?.models.find((model) => model.id === currentModelId) ?? currentGroup?.models[0]
  const currentLabel = currentModel
    ? modelLabel(currentModel.name, currentModel.description)
    : (currentModelId.split('/').pop() ?? 'Model')
  const selectedKey = favoriteModelKey(currentProviderId, currentModelId)

  const { open, setOpen, toggle, close, menuCoords, wrapRef, triggerRef, menuRef } =
    usePortaledMenu({
      placement: 'above',
      minWidth: MENU_WIDTH,
      align: 'start',
      deps: [visibleGroups.length, selectedKey],
    })

  const searchRef = useRef<HTMLInputElement>(null)
  const releaseFocus = useHoldFocus(open, menuRef, searchRef)

  const finish = useCallback(() => {
    releaseFocus()
    close()
    onDone?.()
  }, [releaseFocus, close, onDone])

  // Every open starts from All with nothing typed, on the current model.
  useEffect(() => {
    if (open) return
    setQuery('')
    setScope(ALL_SCOPE)
    setPreviewing(false)
    setHighlighted(null)
  }, [open])

  // The field takes focus as the panel mounts, so typing searches at once.
  useLayoutEffect(() => {
    if (open && menuCoords) searchRef.current?.focus()
  }, [open, menuCoords])

  const disabledRef = useRef(disabled)
  disabledRef.current = disabled
  const openRef = useRef(open)
  openRef.current = open
  const finishRef = useRef(finish)
  finishRef.current = finish
  useEffect(() => {
    if (!shortcut) return
    const parsed = parseShortcut(shortcut)
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || event.defaultPrevented || !matchesShortcut(event, parsed)) return
      if (disabledRef.current) return
      event.preventDefault()
      if (openRef.current) finishRef.current()
      else setOpen(true)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [shortcut, setOpen])

  // The command palette's "Switch model…".
  useRegisterPicker('model', () => setOpen(true), !disabled)

  const toggleFavorite = (key: FavoriteModelKey) => {
    const next = toggleFavoriteModel(favorites, key)
    setFavorites(next)
    writeFavoriteModels(next)
  }

  const pick = (key: string) => {
    const model = modelsByKey.get(key as FavoriteModelKey)
    if (!model || model.unavailableReason) return
    onChange(model.providerId, model.modelId)
    finish()
  }

  const stepScope = (step: 1 | -1) => {
    if (tabs.length === 0) return
    const index = tabs.findIndex((tab) => tab.value === activeScope)
    const next = tabs[(index + step + tabs.length) % tabs.length]
    if (next) setScope(next.value as Scope)
    setPreviewing(false)
  }

  const onSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return
    const mod = event.metaKey || event.ctrlKey
    // With no tabs, Tab leaves the field as usual.
    if (event.key === 'Tab' && tabs.length > 0) {
      event.preventDefault()
      stepScope(event.shiftKey ? -1 : 1)
      return
    }
    if (event.key === 'Escape') {
      // Escape closes outright, even with a query: it is a popover, not a field.
      event.preventDefault()
      finish()
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      setPreviewing(true)
      return
    }
    if (mod && !event.altKey && event.key.toLowerCase() === 's') {
      event.preventDefault()
      if (highlighted) toggleFavorite(highlighted)
      return
    }
    if (event.altKey && !mod && /^Digit[1-9]$/.test(event.code)) {
      event.preventDefault()
      const favorite = favoriteModels[Number(event.code.slice(5)) - 1]
      if (favorite) pick(favorite.key)
    }
  }

  const highlightedModel = highlighted ? modelsByKey.get(highlighted) : undefined
  const metaRows = previewing ? metaRowsFor(highlightedModel) : null

  // The card sits beside the highlighted row, kept inside the panel's height.
  useLayoutEffect(() => {
    const panel = menuRef.current
    if (!open || !metaRows || !highlighted || !panel) {
      setCardTop(null)
      return
    }
    const row = [...panel.querySelectorAll<HTMLElement>('[data-value]')].find(
      (el) => el.dataset.value === highlighted,
    )
    if (!row) {
      setCardTop(null)
      return
    }
    const rowTop = row.getBoundingClientRect().top - panel.getBoundingClientRect().top
    setCardTop(Math.min(Math.max(0, rowTop - 8), Math.max(0, panel.offsetHeight - 8)))
  }, [open, metaRows, highlighted, menuRef])

  const emptyText =
    activeScope === FAVORITES_SCOPE && query.trim() === ''
      ? 'Star a model to pin it here'
      : activeScope !== ALL_SCOPE && tabs.length > 0
        ? 'No models here. Tab to look elsewhere'
        : 'No models match'

  const menu =
    open &&
    menuCoords &&
    createPortal(
      <div
        ref={menuRef}
        role="dialog"
        aria-label="Select model"
        className="fixed z-[200]"
        style={{ left: menuCoords.left, top: menuCoords.top, bottom: menuCoords.bottom }}
        onMouseLeave={() => setPreviewing(false)}
      >
        <div
          className="flex max-h-[min(420px,70vh)] flex-col overflow-hidden rounded-float bg-float shadow-float"
          style={{ width: menuCoords.width }}
        >
          <CommandMenu
            items={items}
            query={query}
            onQueryChange={(next) => {
              setQuery(next)
              setPreviewing(false)
            }}
            onSelect={(item) => pick(item.value)}
            filter={modelMenuFilter}
            defaultHighlight={selectedKey}
            onHighlightChange={(item) =>
              setHighlighted(item ? (item.value as FavoriteModelKey) : null)
            }
          >
            <CommandMenuInput
              ref={searchRef}
              placeholder="Search models…"
              onKeyDown={onSearchKeyDown}
            />
            {tabs.length > 0 && (
              <CommandMenuTabs
                tabs={tabs}
                value={activeScope}
                onValueChange={(value) => {
                  setScope(value as Scope)
                  setPreviewing(false)
                }}
              />
            )}
            <CommandMenuList
              className="gap-0 px-1.5 pb-1.5 pt-0.5"
              // Capture: the list's own handlers drive the highlight fill.
              onMouseMoveCapture={() => setPreviewing(true)}
              renderItem={(item) => {
                const model = modelsByKey.get(item.value as FavoriteModelKey)
                if (!model) return null
                return (
                  <ModelRow
                    model={model}
                    current={model.key === selectedKey}
                    favorited={favorites.includes(model.key)}
                    favoriteNumber={
                      activeScope === FAVORITES_SCOPE ? favoriteNumber.get(model.key) : undefined
                    }
                    onToggleFavorite={() => toggleFavorite(model.key)}
                  />
                )
              }}
            >
              <CommandMenuEmpty>{emptyText}</CommandMenuEmpty>
            </CommandMenuList>
            <PickerFooter hasTabs={tabs.length > 0} hasFavorites={favoriteNumber.size > 0} />
          </CommandMenu>
        </div>

        {metaRows && cardTop !== null && <ModelMetaCard rows={metaRows} top={cardTop} />}
      </div>,
      document.body,
    )

  return (
    <div ref={wrapRef} className="relative shrink-0">
      <Tooltip content={<ShortcutTooltip label="Switch model" shortcut={shortcut} />} side="top">
        <button
          ref={triggerRef}
          type="button"
          onClick={() => {
            if (!disabled) toggle()
          }}
          disabled={disabled}
          aria-haspopup="dialog"
          aria-expanded={open}
          className={cn(
            composerChip,
            'max-w-[240px] gap-1.5',
            open && 'bg-active text-[var(--basis-text-strong)]',
          )}
        >
          <ProviderIcon providerId={currentProviderId} />
          <span className="truncate">{currentLabel}</span>
          <CaretDownIcon
            size={9}
            weight="light"
            className="shrink-0 text-[var(--basis-text-faint)]"
          />
        </button>
      </Tooltip>
      {menu}
    </div>
  )
}

/** Like the menu's default filter, but a model's keywords (provider, id) are
 *  its own rather than shared across a group, so they match anywhere: "gpt-5"
 *  finds `openai/gpt-5`. */
function modelMenuFilter(item: CommandMenuItemData, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const text = [item.label, item.description ?? '', ...(item.keywords ?? [])]
    .join(' ')
    .toLowerCase()
  return words.every((word) => text.includes(word))
}

function ShortcutTooltip({ label, shortcut }: { label: string; shortcut?: string }) {
  if (!shortcut) return <>{label}</>
  return (
    <span className="flex items-center gap-2">
      {label}
      <CommandMenuShortcut keys={shortcut} className="ml-0" />
    </span>
  )
}

function ModelRow({
  model,
  current,
  favorited,
  favoriteNumber,
  onToggleFavorite,
}: {
  model: FlatModel
  current: boolean
  favorited: boolean
  favoriteNumber?: number
  onToggleFavorite: () => void
}) {
  const description = model.unavailableReason ?? model.description
  return (
    <CommandMenuItem
      value={model.key}
      className="group/row h-auto min-h-9 gap-2.5 px-2.5 py-1.5 text-[13px] text-foreground"
    >
      <ProviderIcon providerId={model.providerId} className="h-3.5 w-3.5 shrink-0" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate leading-[18px]">{model.label}</span>
        {description && (
          <span className="truncate text-[11.5px] leading-4 text-muted-foreground/70">
            {description}
          </span>
        )}
      </span>
      {model.contextWindowTokens && (
        <span className="shrink-0 rounded-[4px] bg-hover px-1.5 py-px text-[10.5px] leading-4 text-muted-foreground">
          {formatContextShort(model.contextWindowTokens)}
        </span>
      )}
      {favoriteNumber !== undefined && (
        <CommandMenuShortcut keys={`alt+${favoriteNumber}`} className="ml-0" />
      )}
      <button
        type="button"
        tabIndex={-1}
        aria-label={favorited ? `Unfavorite ${model.label}` : `Favorite ${model.label}`}
        aria-pressed={favorited}
        onClick={(event: ReactMouseEvent) => {
          // The row picks on click; the star only stars.
          event.stopPropagation()
          onToggleFavorite()
        }}
        className={cn(
          // pointer-events-auto: an unavailable row ignores the pointer, but
          // its models can still be starred for later.
          'pointer-events-auto flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-[opacity,color] duration-100',
          favorited
            ? 'text-[var(--basis-text)]'
            : 'text-muted-foreground opacity-0 hover:opacity-100 group-hover/row:opacity-100 group-aria-selected/row:opacity-100',
          'hover:text-foreground',
        )}
      >
        <StarIcon size={13} weight={favorited ? 'fill' : 'regular'} />
      </button>
      <span className="flex w-3.5 shrink-0 justify-center">
        {current && <CheckIcon aria-label="Current model" size={14} className="text-foreground" />}
      </span>
    </CommandMenuItem>
  )
}

/** Only the keys the menu adds; arrows and Enter go without saying. */
function PickerFooter({ hasTabs, hasFavorites }: { hasTabs: boolean; hasFavorites: boolean }) {
  return (
    <div className="flex h-8 shrink-0 items-center gap-3 px-3 text-[11px] text-muted-foreground pointer-coarse:hidden">
      {hasTabs && (
        <span className="flex items-center gap-1.5">
          <CommandMenuShortcut keys="tab" className="ml-0" />
          Provider
        </span>
      )}
      <span className="flex items-center gap-1.5">
        <CommandMenuShortcut keys="mod+s" className="ml-0" />
        Favorite
      </span>
      {hasFavorites && (
        <span className="ml-auto flex items-center gap-1.5">
          <CommandMenuShortcut keys={['alt', '1–9']} className="ml-0" />
          Favorites
        </span>
      )}
    </div>
  )
}

function ModelMetaCard({ rows, top }: { rows: MetaRow[]; top: number }) {
  return (
    <div
      className="pointer-events-none absolute left-[calc(100%+8px)] z-[201] max-md:hidden w-[232px] rounded-[10px] bg-float px-3 py-2.5 shadow-float"
      style={{ top }}
      role="tooltip"
    >
      <dl className="flex flex-col gap-1">
        {rows.map((row) => (
          <div key={row.label} className="grid grid-cols-[76px_minmax(0,1fr)] items-start gap-2">
            <dt className="text-[11px] leading-4 text-[var(--basis-text-faint)]">{row.label}</dt>
            <dd
              className="truncate text-[11px] leading-4 text-[var(--basis-text)]"
              title={row.value}
            >
              {row.value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  )
}
