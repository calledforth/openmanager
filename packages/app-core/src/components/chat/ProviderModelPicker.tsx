import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { CaretDownIcon, MagnifyingGlassIcon, StarIcon } from '@phosphor-icons/react'
import type { ProviderId } from '@agentpack/contract'
import { cn } from '../../lib/utils'
import { ProviderIcon } from '../providers/ProviderIcon'
import { Tooltip } from '../ui/Tooltip'
import { usePortaledMenu } from '../ui/usePortaledMenu'
import { modelHint, modelLabel } from './modelLabel'
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
}

export type ProviderModelGroup = {
  providerId: ProviderId
  providerName: string
  models: ProviderModelOption[]
}

/** Picker rail order — favorites sit above these. */
const PROVIDER_RAIL_ORDER: readonly ProviderId[] = ['claude', 'cursor', 'opencode']

const FAVORITES_PANE = '__favorites__' as const
type PaneId = typeof FAVORITES_PANE | ProviderId

const MENU_WIDTH = 400
const MENU_MIN_HEIGHT = 320
const MENU_MAX_HEIGHT = 360

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
  supportsAutoMode?: boolean
  contextWindowTokens?: number
  keywords: string
}

type MetaRow = { label: string; value: string }

function sortGroups(groups: ProviderModelGroup[]): ProviderModelGroup[] {
  const rank = new Map(PROVIDER_RAIL_ORDER.map((id, index) => [id, index]))
  return [...groups].sort((a, b) => (rank.get(a.providerId) ?? 99) - (rank.get(b.providerId) ?? 99))
}

function matchesQuery(model: FlatModel, query: string) {
  if (!query) return true
  return model.keywords.toLowerCase().includes(query)
}

function formatContextTokens(tokens: number): string {
  return tokens.toLocaleString('en-US')
}

/** Claude Code is the only provider that ships rich model metadata today. */
function claudeMetaRows(model: FlatModel): MetaRow[] {
  const rows: MetaRow[] = [
    { label: 'Model', value: model.label },
    { label: 'Provider', value: model.providerName },
    { label: 'Inputs', value: 'text' },
  ]

  if (model.resolvedModel) {
    rows.push({ label: 'Resolves to', value: model.resolvedModel })
  }

  if (model.effortLevels?.length) {
    const first = model.effortLevels[0]
    const last = model.effortLevels[model.effortLevels.length - 1]
    rows.push({
      label: 'Reasoning',
      value: first === last ? first : `${first}–${last}`,
    })
  } else {
    rows.push({ label: 'Reasoning', value: 'No effort control' })
  }

  rows.push({
    label: 'Fast mode',
    value: model.supportsFastMode ? 'Supported' : 'Not supported',
  })

  if (model.contextWindowTokens) {
    rows.push({ label: 'Context', value: formatContextTokens(model.contextWindowTokens) })
  }

  if (model.description) {
    rows.push({ label: 'Notes', value: model.description })
  }

  return rows
}

function metaRowsFor(model: FlatModel | undefined): MetaRow[] | null {
  if (!model || model.providerId !== 'claude') return null
  return claudeMetaRows(model)
}

/** Compact two-pane provider→model menu. Search collapses to a single list. */
export function ProviderModelPicker({
  groups,
  currentProviderId,
  currentModelId,
  onChange,
  disabled,
  canChangeProvider,
  configSummary,
}: {
  groups: ProviderModelGroup[]
  currentProviderId: ProviderId
  currentModelId: string
  onChange: (providerId: ProviderId, modelId: string) => void
  disabled?: boolean
  canChangeProvider: boolean
  configSummary: string[]
}) {
  const listId = useId()
  const searchRef = useRef<HTMLInputElement>(null)
  const rowRefs = useRef(new Map<string, HTMLDivElement>())
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const [favorites, setFavorites] = useState<FavoriteModelKey[]>(() => readFavoriteModels())
  const [paneId, setPaneId] = useState<PaneId>(currentProviderId)
  const [hoverCardTop, setHoverCardTop] = useState<number | null>(null)
  // The meta card is a hover affordance: it only appears once the user actually
  // points at (or keyboard-navigates to) a row, never on the default row 0.
  const [previewing, setPreviewing] = useState(false)

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
            ...(model.supportsAutoMode ? { supportsAutoMode: true } : {}),
            ...(model.contextWindowTokens
              ? { contextWindowTokens: model.contextWindowTokens }
              : {}),
            keywords: `${group.providerName} ${model.id} ${model.name} ${model.description ?? ''} ${label}`,
          }
        }),
      ),
    [visibleGroups],
  )

  const favoriteModels = useMemo(() => {
    const byKey = new Map(allModels.map((model) => [model.key, model]))
    return favorites
      .map((key) => byKey.get(key))
      .filter((model): model is FlatModel => model !== undefined)
  }, [allModels, favorites])

  const currentGroup = groups.find((group) => group.providerId === currentProviderId)
  const currentModel =
    currentGroup?.models.find((model) => model.id === currentModelId) ?? currentGroup?.models[0]
  const currentLabel = currentModel
    ? modelLabel(currentModel.name, currentModel.description)
    : (currentModelId.split('/').pop() ?? 'Model')
  const displayLabel =
    configSummary.length > 0 ? `${currentLabel} · ${configSummary.join(' · ')}` : currentLabel
  const selectedKey = favoriteModelKey(currentProviderId, currentModelId)

  const searching = query.trim().length > 0
  const normalizedQuery = query.trim().toLowerCase()

  const paneModels = useMemo(() => {
    if (searching) return allModels.filter((model) => matchesQuery(model, normalizedQuery))
    if (paneId === FAVORITES_PANE) return favoriteModels
    return allModels.filter((model) => model.providerId === paneId)
  }, [allModels, favoriteModels, normalizedQuery, paneId, searching])

  const canShowRail = visibleGroups.length > 1 || favoriteModels.length > 0 || favorites.length > 0
  const showRail = !searching && canShowRail

  const activeModel = paneModels[activeIndex]
  const metaRows = previewing ? metaRowsFor(activeModel) : null

  const { open, toggle, close, menuCoords, wrapRef, triggerRef, menuRef } = usePortaledMenu({
    placement: 'above',
    minWidth: MENU_WIDTH,
    align: 'start',
    deps: [visibleGroups.length, selectedKey, showRail],
  })

  useEffect(() => {
    if (!open) {
      setQuery('')
      setActiveIndex(0)
      setHoverCardTop(null)
      setPreviewing(false)
      return
    }
    const preferred: PaneId = visibleGroups.some((group) => group.providerId === currentProviderId)
      ? currentProviderId
      : (visibleGroups[0]?.providerId ?? FAVORITES_PANE)
    setPaneId(preferred)
    setActiveIndex(0)
    requestAnimationFrame(() => searchRef.current?.focus())
  }, [open, currentProviderId, visibleGroups])

  useEffect(() => {
    if (activeIndex >= paneModels.length) {
      setActiveIndex(Math.max(0, paneModels.length - 1))
    }
  }, [activeIndex, paneModels.length])

  // Drop a pane that disappeared (e.g. last favorite removed).
  useEffect(() => {
    if (paneId === FAVORITES_PANE) return
    if (!visibleGroups.some((group) => group.providerId === paneId)) {
      setPaneId(visibleGroups[0]?.providerId ?? FAVORITES_PANE)
    }
  }, [paneId, visibleGroups])

  useLayoutEffect(() => {
    if (!open || !metaRows || !activeModel) {
      setHoverCardTop(null)
      return
    }
    const row = rowRefs.current.get(activeModel.key)
    const menu = menuRef.current
    if (!row || !menu) {
      setHoverCardTop(null)
      return
    }
    const rowRect = row.getBoundingClientRect()
    const menuRect = menu.getBoundingClientRect()
    // Keep the card within the menu’s vertical bounds so it doesn’t float away.
    const rawTop = rowRect.top - menuRect.top
    const maxTop = Math.max(0, menuRect.height - 8)
    setHoverCardTop(Math.min(Math.max(0, rawTop), maxTop))
  }, [activeModel, metaRows, open, paneModels, menuRef])

  const persistFavorites = (next: FavoriteModelKey[]) => {
    setFavorites(next)
    writeFavoriteModels(next)
  }

  const onToggleFavorite = (key: FavoriteModelKey) => {
    persistFavorites(toggleFavoriteModel(favorites, key))
  }

  const selectModel = (model: FlatModel) => {
    onChange(model.providerId, model.modelId)
    close()
  }

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setPreviewing(true)
      setActiveIndex((index) => (paneModels.length === 0 ? 0 : (index + 1) % paneModels.length))
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setPreviewing(true)
      setActiveIndex((index) =>
        paneModels.length === 0 ? 0 : (index - 1 + paneModels.length) % paneModels.length,
      )
      return
    }
    if (event.key === 'Enter') {
      const model = paneModels[activeIndex]
      if (!model) return
      event.preventDefault()
      selectModel(model)
    }
  }

  const menu =
    open &&
    menuCoords &&
    createPortal(
      <div
        ref={menuRef}
        className="fixed z-[200]"
        style={{
          left: menuCoords.left,
          top: menuCoords.top,
          bottom: menuCoords.bottom,
        }}
      >
        <div
          role="listbox"
          id={listId}
          aria-label="Select model"
          onKeyDown={onMenuKeyDown}
          className={cn(
            'relative flex flex-col overflow-hidden bg-[var(--basis-canvas-bg)]',
            'rounded-[calc(var(--basis-chat-shell-radius)+4px)]',
            'shadow-[0_16px_40px_rgba(0,0,0,0.22)]',
          )}
          style={{
            width: MENU_WIDTH,
            minHeight: MENU_MIN_HEIGHT,
            maxHeight: MENU_MAX_HEIGHT,
          }}
        >
          <div className="shrink-0 px-3 pb-1 pt-3">
            <div className="flex items-center gap-2 rounded-[var(--basis-chat-shell-radius)] border border-[var(--basis-border)] bg-[var(--basis-surface)] px-2.5 py-2 text-[var(--basis-text-faint)]">
              <MagnifyingGlassIcon weight="light" className="h-3.5 w-3.5 shrink-0" />
              <input
                ref={searchRef}
                type="text"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value)
                  setActiveIndex(0)
                  setPreviewing(false)
                }}
                placeholder="Search models…"
                className="min-w-0 flex-1 bg-transparent text-[12px] font-normal leading-[var(--lh-default)] tracking-[var(--tracking-normal)] text-[var(--basis-text)] outline-none [font-variation-settings:'wght'_450] placeholder:text-[var(--basis-text-muted)]"
              />
            </div>
          </div>

          <div
            className={cn('flex min-h-0 flex-1', showRail ? 'gap-1.5 p-2 pt-1.5' : 'px-1.5 pb-2')}
          >
            {showRail && (
              <div
                role="tablist"
                aria-label="Agent providers"
                className="flex w-12 shrink-0 flex-col gap-0.5 overflow-y-auto rounded-[var(--basis-chat-shell-radius)] border border-[var(--basis-border)] bg-[var(--basis-surface)] py-1.5"
              >
                <RailButton
                  selected={paneId === FAVORITES_PANE}
                  label="Favorites"
                  onSelect={() => {
                    setPaneId(FAVORITES_PANE)
                    setActiveIndex(0)
                    setPreviewing(false)
                  }}
                >
                  <StarIcon
                    size={15}
                    weight={paneId === FAVORITES_PANE ? 'fill' : 'regular'}
                    className="text-current"
                  />
                </RailButton>

                {visibleGroups.length > 0 && (
                  <div className="mx-2.5 my-1 h-px bg-[var(--basis-border-muted)]/70" />
                )}

                {visibleGroups.map((group) => (
                  <RailButton
                    key={group.providerId}
                    selected={paneId === group.providerId}
                    label={group.providerName}
                    onSelect={() => {
                      setPaneId(group.providerId)
                      setActiveIndex(0)
                      setPreviewing(false)
                    }}
                  >
                    <ProviderIcon providerId={group.providerId} className="h-4 w-4" />
                  </RailButton>
                ))}
              </div>
            )}

            <div className="flex min-w-0 flex-1 flex-col">
              <div
                className="min-h-0 flex-1 overflow-y-auto py-0.5"
                onMouseLeave={() => setPreviewing(false)}
              >
                {paneModels.map((model, index) => {
                  const selected = model.key === selectedKey
                  const active = index === activeIndex
                  const favorited = favorites.includes(model.key)
                  return (
                    <div
                      key={model.key}
                      ref={(node) => {
                        if (node) rowRefs.current.set(model.key, node)
                        else rowRefs.current.delete(model.key)
                      }}
                      className={cn(
                        'group relative flex w-full items-center gap-1 rounded-md px-1.5',
                        selected
                          ? 'bg-[var(--basis-surface)]'
                          : active
                            ? 'bg-[var(--basis-surface)]/70'
                            : 'hover:bg-[var(--basis-surface)]/70',
                      )}
                      onMouseEnter={() => {
                        setActiveIndex(index)
                        setPreviewing(true)
                      }}
                    >
                      {selected && (
                        <span
                          aria-hidden
                          className="absolute bottom-1.5 left-0 top-1.5 w-0.5 rounded-full bg-[var(--basis-text-strong)]"
                        />
                      )}
                      <button
                        type="button"
                        role="option"
                        aria-selected={selected}
                        onClick={() => selectModel(model)}
                        className={cn(
                          'flex min-w-0 flex-1 items-center gap-2 px-1.5 py-1.5 text-left text-11-regular leading-none transition-colors',
                          selected
                            ? 'text-[var(--basis-text-strong)]'
                            : active
                              ? 'text-[var(--basis-text)]'
                              : 'text-[var(--basis-text-muted)] group-hover:text-[var(--basis-text)]',
                        )}
                      >
                        <ProviderIcon providerId={model.providerId} className="h-3.5 w-3.5" />
                        <span className="min-w-0 flex-1 truncate">{model.label}</span>
                      </button>
                      <Tooltip content={favorited ? 'Remove favorite' : 'Add favorite'} side="left">
                        <button
                          type="button"
                          aria-label={
                            favorited ? `Unfavorite ${model.label}` : `Favorite ${model.label}`
                          }
                          aria-pressed={favorited}
                          onClick={(event) => {
                            event.stopPropagation()
                            onToggleFavorite(model.key)
                          }}
                          className={cn(
                            'flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors',
                            favorited
                              ? 'text-[var(--basis-text)]'
                              : 'text-[var(--basis-text-faint)] opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
                            'hover:bg-[var(--basis-surface-hover)] hover:text-[var(--basis-text)]',
                          )}
                        >
                          <StarIcon size={12} weight={favorited ? 'fill' : 'regular'} />
                        </button>
                      </Tooltip>
                    </div>
                  )
                })}

                {paneModels.length === 0 && (
                  <div className="px-3 py-3 text-11-regular text-[var(--basis-text-faint)]">
                    {searching
                      ? 'No models'
                      : paneId === FAVORITES_PANE
                        ? 'Star models to pin them here'
                        : 'No models'}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {metaRows && hoverCardTop !== null && <ModelMetaCard rows={metaRows} top={hoverCardTop} />}
      </div>,
      document.body,
    )

  return (
    <div ref={wrapRef} className="relative shrink-0">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          if (!disabled) toggle()
        }}
        disabled={disabled}
        className={cn(
          'flex max-w-[240px] items-center gap-1.5 border-0 bg-transparent px-0.5 py-0 text-11-regular leading-none text-[var(--basis-text)] transition-colors duration-150',
          'hover:text-[var(--basis-text-strong)]',
          open && 'text-[var(--basis-text-strong)]',
          disabled && 'cursor-default opacity-40',
        )}
      >
        <ProviderIcon providerId={currentProviderId} />
        <span className="truncate">{displayLabel}</span>
        <CaretDownIcon
          size={9}
          weight="light"
          className="shrink-0 text-[var(--basis-text-faint)]"
        />
      </button>
      {menu}
    </div>
  )
}

function ModelMetaCard({ rows, top }: { rows: MetaRow[]; top: number }) {
  return (
    <div
      className={cn(
        'pointer-events-none absolute left-[calc(100%+10px)] z-[201] w-[220px]',
        'rounded-[var(--basis-chat-shell-radius)] border border-[var(--basis-border)]',
        'bg-[var(--basis-surface)] px-3 py-2.5 shadow-[0_12px_32px_rgba(0,0,0,0.2)]',
      )}
      style={{ top }}
      role="tooltip"
    >
      <dl className="flex flex-col gap-1">
        {rows.map((row) => (
          <div key={row.label} className="grid grid-cols-[72px_minmax(0,1fr)] items-start gap-2">
            <dt className="text-[10px] leading-4 text-[var(--basis-text-faint)]">{row.label}</dt>
            <dd
              className="truncate text-[10px] leading-4 text-[var(--basis-text)]"
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

function RailButton({
  selected,
  label,
  onSelect,
  children,
}: {
  selected: boolean
  label: string
  onSelect: () => void
  children: ReactNode
}) {
  return (
    <Tooltip content={label} side="right">
      <button
        type="button"
        role="tab"
        aria-selected={selected}
        aria-label={label}
        onClick={onSelect}
        className={cn(
          'relative mx-1 flex h-9 w-[calc(100%-0.5rem)] items-center justify-center rounded-md text-[var(--basis-text-muted)] transition-colors',
          'hover:bg-[var(--basis-surface-hover)] hover:text-[var(--basis-text)]',
          selected &&
            'bg-[var(--basis-surface-hover)] text-[var(--basis-text-strong)] ring-1 ring-[var(--basis-border)]',
        )}
      >
        <span className={cn('opacity-70 transition-opacity', selected && 'opacity-100')}>
          {children}
        </span>
      </button>
    </Tooltip>
  )
}
