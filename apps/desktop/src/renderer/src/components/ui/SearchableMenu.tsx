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
import { usePortaledMenu, type MenuPlacement } from './usePortaledMenu'

export type SearchableMenuOption = {
  id: string
  label: string
  description?: string
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
  onSelect: (optionId: string, sectionId: string) => void
  searchable?: boolean
  searchPlaceholder?: string
  emptyText?: string
  footer?: ReactNode | ((api: { close: () => void }) => ReactNode)
  disabled?: boolean
  placement?: MenuPlacement
  minWidth?: number
  maxHeight?: number
  align?: 'start' | 'center' | 'end'
  'aria-label'?: string
}

type FlatOption = SearchableMenuOption & { sectionId: string }

function matchesQuery(option: SearchableMenuOption, query: string) {
  if (!query) return true
  const haystack = [option.label, option.description, option.keywords]
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
  'aria-label': ariaLabel = 'Menu',
}: SearchableMenuProps) {
  const listId = useId()
  const searchRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)

  const { open, toggle, close, menuCoords, wrapRef, triggerRef, menuRef } = usePortaledMenu({
    placement,
    minWidth,
    align,
    deps: [sections.length, value, searchable],
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
    onSelect(option.id, option.sectionId)
    close()
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
        flatOptions.length === 0
          ? 0
          : (index - 1 + flatOptions.length) % flatOptions.length,
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
          'fixed z-[200] flex flex-col overflow-hidden border border-[var(--basis-border)] bg-[var(--basis-canvas-bg)] shadow-xl',
          'rounded-[var(--basis-chat-shell-radius)]',
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
          <div className="shrink-0 border-b border-[var(--basis-border-muted)] px-2.5 py-1.5">
            <div className="flex items-center gap-1.5 text-[var(--basis-text-faint)]">
              <MagnifyingGlassIcon weight="light" className="h-3.5 w-3.5 shrink-0" />
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

        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          {filteredSections.map((section, sectionIndex) => (
            <div key={section.id}>
              {sectionIndex > 0 && (
                <div className="my-1 h-px bg-[var(--basis-border-muted)]" />
              )}
              {section.label && (
                <div className="flex items-center gap-1.5 px-2.5 pb-0.5 pt-1 text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--basis-text-faint)]">
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
                return (
                  <button
                    key={`${section.id}:${option.id}`}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    disabled={option.disabled}
                    onMouseEnter={() => setActiveIndex(flatIndex)}
                    onClick={() => selectOption({ ...option, sectionId: section.id })}
                    className={cn(
                      'flex w-full items-center gap-2 px-2.5 py-1 text-left transition-colors',
                      'text-11-regular',
                      option.disabled && 'cursor-default opacity-40',
                      selected
                        ? 'bg-[var(--basis-surface-hover)] text-[var(--basis-text-strong)]'
                        : active
                          ? 'bg-[var(--basis-surface)] text-[var(--basis-text)]'
                          : 'text-[var(--basis-text-muted)] hover:bg-[var(--basis-surface)] hover:text-[var(--basis-text)]',
                    )}
                  >
                    {option.icon && <span className="shrink-0">{option.icon}</span>}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{option.label}</span>
                      {option.description && (
                        <span className="block truncate text-[10px] text-[var(--basis-text-faint)]">
                          {option.description}
                        </span>
                      )}
                    </span>
                    {selected && (
                      <CheckIcon className="h-3 w-3 shrink-0 text-[var(--basis-text)]" />
                    )}
                  </button>
                )
              })}
            </div>
          ))}

          {flatOptions.length === 0 && (
            <div className="px-2.5 py-2 text-11-regular text-[var(--basis-text-faint)]">
              {emptyText}
            </div>
          )}
        </div>

        {footer && (
          <div className="shrink-0 border-t border-[var(--basis-border-muted)] py-1">
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
