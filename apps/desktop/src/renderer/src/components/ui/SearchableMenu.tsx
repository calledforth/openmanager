import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import { CheckIcon, MagnifyingGlassIcon } from '@phosphor-icons/react'
import { cn } from '../../lib/utils'
import { Tooltip } from './Tooltip'
import { usePortaledMenu, type MenuPlacement } from './usePortaledMenu'

export type SearchableMenuOption = {
  id: string
  label: string
  /** Rendered as a second line under the label. */
  description?: string
  /** Hover tip. For menus where the explanation matters but should not
   * cost a row of height every time the menu opens — the mode and effort
   * pickers, where descriptions disambiguate rather than inform. */
  title?: string
  icon?: ReactNode
  disabled?: boolean
  keywords?: string
}

export type SearchableMenuSection = {
  id: string
  label?: string
  icon?: ReactNode
  options: SearchableMenuOption[]
}

export type SearchableMenuTriggerApi = {
  ref: RefObject<HTMLButtonElement | null>
  open: boolean
  toggle: () => void
  disabled: boolean
}

type SearchableMenuProps = {
  trigger: (api: SearchableMenuTriggerApi) => ReactNode
  sections: SearchableMenuSection[]
  value?: string
  onSelect: (optionId: string, sectionId: string) => void | boolean
  searchable?: boolean
  searchPlaceholder?: string
  emptyText?: string
  footer?: ReactNode | ((api: { close: () => void }) => ReactNode)
  disabled?: boolean
  placement?: MenuPlacement
  minWidth?: number
  maxHeight?: number
  align?: 'start' | 'center' | 'end'
  /** `island` matches the model-picker shell: soft outer shadow, bordered
   * search field, roomier rows, and a left accent for the selected item. */
  variant?: 'default' | 'island'
  'aria-label'?: string
}

type FlatOption = SearchableMenuOption & { sectionId: string }

function matchesQuery(option: SearchableMenuOption, query: string) {
  if (!query) return true
  const haystack = [option.label, option.description, option.title, option.keywords]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  return haystack.includes(query)
}

export function SearchableMenu({
  trigger,
  sections,
  value,
  onSelect,
  searchable = false,
  searchPlaceholder = 'Search…',
  emptyText = 'No results',
  footer,
  disabled = false,
  placement = 'above',
  minWidth = 240,
  maxHeight = 320,
  align = 'start',
  variant = 'default',
  'aria-label': ariaLabel = 'Menu',
}: SearchableMenuProps) {
  const listId = useId()
  const searchRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const island = variant === 'island'

  const { open, toggle, close, menuCoords, wrapRef, triggerRef, menuRef } = usePortaledMenu({
    placement,
    minWidth,
    align,
    deps: [sections.length, value, searchable, variant],
  })

  const filteredSections = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    return sections
      .map((section) => ({
        ...section,
        options: section.options.filter((option) => matchesQuery(option, normalized)),
      }))
      .filter((section) => section.options.length > 0)
  }, [query, sections])

  const flatOptions = useMemo<FlatOption[]>(
    () =>
      filteredSections.flatMap((section) =>
        section.options.map((option) => ({ ...option, sectionId: section.id })),
      ),
    [filteredSections],
  )

  useEffect(() => {
    if (!open) {
      setQuery('')
      setActiveIndex(0)
      return
    }
    setActiveIndex(0)
    if (searchable) {
      requestAnimationFrame(() => searchRef.current?.focus())
    }
  }, [open, searchable])

  useEffect(() => {
    if (activeIndex >= flatOptions.length) {
      setActiveIndex(Math.max(0, flatOptions.length - 1))
    }
  }, [activeIndex, flatOptions.length])

  const selectOption = (option: FlatOption) => {
    if (option.disabled) return
    const shouldClose = onSelect(option.id, option.sectionId)
    if (shouldClose !== false) close()
  }

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((index) => (flatOptions.length === 0 ? 0 : (index + 1) % flatOptions.length))
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((index) =>
        flatOptions.length === 0 ? 0 : (index - 1 + flatOptions.length) % flatOptions.length,
      )
      return
    }
    if (event.key === 'Enter') {
      const option = flatOptions[activeIndex]
      if (!option) return
      event.preventDefault()
      selectOption(option)
    }
  }

  const menu =
    open &&
    menuCoords &&
    createPortal(
      <div
        ref={menuRef}
        role="listbox"
        id={listId}
        aria-label={ariaLabel}
        onKeyDown={onMenuKeyDown}
        className={cn(
          'fixed z-[200] flex flex-col overflow-hidden bg-[var(--basis-canvas-bg)]',
          island
            ? cn(
                'rounded-[calc(var(--basis-chat-shell-radius)+4px)]',
                'shadow-[0_16px_40px_rgba(0,0,0,0.22)]',
              )
            : cn(
                'rounded-[var(--basis-chat-shell-radius)] border border-[var(--basis-border)] shadow-xl',
              ),
        )}
        style={{
          left: menuCoords.left,
          top: menuCoords.top,
          bottom: menuCoords.bottom,
          width: menuCoords.width,
          maxHeight,
        }}
      >
        {searchable && (
          <div
            className={cn(
              'shrink-0',
              island
                ? 'px-2.5 pb-1 pt-2'
                : 'border-b border-[var(--basis-border-muted)] px-2.5 py-1.5',
            )}
          >
            <div
              className={cn(
                'flex items-center text-[var(--basis-text-faint)]',
                island ? 'gap-1.5 px-1 py-0.5' : 'gap-1.5',
              )}
            >
              <MagnifyingGlassIcon
                weight="light"
                className={cn('shrink-0', island ? 'h-3 w-3' : 'h-3.5 w-3.5')}
              />
              <input
                ref={searchRef}
                type="text"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value)
                  setActiveIndex(0)
                }}
                placeholder={searchPlaceholder}
                className="min-w-0 flex-1 bg-transparent text-[11px] font-normal leading-[var(--lh-default)] tracking-[var(--tracking-normal)] text-[var(--basis-text)] outline-none [font-variation-settings:'wght'_450] placeholder:text-[var(--basis-text-muted)]"
              />
            </div>
          </div>
        )}

        <div
          className={cn(
            'min-h-0 flex-1 overflow-y-auto',
            island ? 'px-1.5 py-1.5' : 'py-1',
            island && searchable && 'pt-1',
          )}
        >
          {filteredSections.map((section, sectionIndex) => (
            <div key={section.id}>
              {sectionIndex > 0 && <div className="my-1 h-px bg-[var(--basis-border-muted)]" />}
              {section.label && (
                <div
                  className={cn(
                    'flex items-center gap-1.5 text-[10px] font-medium tracking-[var(--tracking-normal)] text-[var(--basis-text-faint)]',
                    island ? 'px-2.5 pb-1 pt-1' : 'px-2.5 pb-0.5 pt-1 uppercase tracking-[0.08em]',
                  )}
                >
                  {section.icon}
                  <span className="truncate">{section.label}</span>
                </div>
              )}
              {section.options.map((option) => {
                const flatIndex = flatOptions.findIndex(
                  (entry) => entry.id === option.id && entry.sectionId === section.id,
                )
                const selected = option.id === value
                const active = flatIndex === activeIndex
                const row = (
                  <button
                    type="button"
                    role="option"
                    aria-selected={selected}
                    disabled={option.disabled}
                    onMouseEnter={() => setActiveIndex(flatIndex)}
                    onClick={() => selectOption({ ...option, sectionId: section.id })}
                    className={cn(
                      'relative flex w-full items-center text-left transition-colors',
                      'text-11-regular',
                      island ? 'gap-2 rounded-md px-2.5 py-1.5' : 'gap-2 px-2.5 py-1',
                      option.disabled && 'cursor-default opacity-40',
                      selected
                        ? island
                          ? 'bg-[var(--basis-surface)] text-[var(--basis-text-strong)]'
                          : 'bg-[var(--basis-surface-hover)] text-[var(--basis-text-strong)]'
                        : active
                          ? island
                            ? 'bg-[var(--basis-surface)]/70 text-[var(--basis-text)]'
                            : 'bg-[var(--basis-surface)] text-[var(--basis-text)]'
                          : island
                            ? 'text-[var(--basis-text-muted)] hover:bg-[var(--basis-surface)]/70 hover:text-[var(--basis-text)]'
                            : 'text-[var(--basis-text-muted)] hover:bg-[var(--basis-surface)] hover:text-[var(--basis-text)]',
                    )}
                  >
                    {island && selected && (
                      <span
                        aria-hidden
                        className="absolute bottom-1.5 left-0 top-1.5 w-0.5 rounded-full bg-[var(--basis-text-strong)]"
                      />
                    )}
                    {option.icon && <span className="shrink-0">{option.icon}</span>}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{option.label}</span>
                      {option.description && (
                        <span className="block truncate text-[10px] text-[var(--basis-text-faint)]">
                          {option.description}
                        </span>
                      )}
                    </span>
                    {!island && selected && (
                      <CheckIcon className="h-3 w-3 shrink-0 text-[var(--basis-text)]" />
                    )}
                  </button>
                )

                if (!option.title) {
                  return <div key={`${section.id}:${option.id}`}>{row}</div>
                }

                return (
                  <Tooltip
                    key={`${section.id}:${option.id}`}
                    content={option.title}
                    side="right"
                    align="center"
                  >
                    {row}
                  </Tooltip>
                )
              })}
            </div>
          ))}

          {flatOptions.length === 0 && (
            <div
              className={cn(
                'text-11-regular text-[var(--basis-text-faint)]',
                island ? 'px-3 py-3' : 'px-2.5 py-2',
              )}
            >
              {emptyText}
            </div>
          )}
        </div>

        {footer && (
          <div
            className={cn(
              'shrink-0',
              island
                ? 'mx-2 border-t border-[var(--basis-border-muted)]/80 py-0.5'
                : 'border-t border-[var(--basis-border-muted)] py-1',
            )}
          >
            {typeof footer === 'function' ? footer({ close }) : footer}
          </div>
        )}
      </div>,
      document.body,
    )

  return (
    <div ref={wrapRef} className="relative shrink-0">
      {trigger({
        ref: triggerRef,
        open,
        toggle: () => {
          if (!disabled) toggle()
        },
        disabled,
      })}
      {menu}
    </div>
  )
}
