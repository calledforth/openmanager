import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '../../lib/utils'
import type { SlashCommandItem } from './slashCommands'

type PopupCoords = { left: number; bottom: number; width: number }

/**
 * Typeahead list for `/command` completion. Unlike SearchableMenu this owns no
 * trigger and no search field: the composer textarea is both, so open state,
 * query and active index live in the parent and arrive as props.
 */
export function SlashCommandPopup({
  anchorRef,
  commands,
  activeIndex,
  onActiveIndexChange,
  onSelect,
  onDismiss,
}: {
  anchorRef: RefObject<HTMLElement | null>
  commands: SlashCommandItem[]
  activeIndex: number
  onActiveIndexChange: (index: number) => void
  onSelect: (command: SlashCommandItem) => void
  onDismiss: () => void
}) {
  const [coords, setCoords] = useState<PopupCoords | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const update = () => {
      const el = anchorRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const width = Math.max(280, rect.width)
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))
      setCoords({ left, bottom: window.innerHeight - rect.top + 6, width })
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [anchorRef, commands.length])

  useEffect(() => {
    const handler = (event: MouseEvent) => {
      const target = event.target as Node
      if (anchorRef.current?.contains(target)) return
      // The list is portaled outside the anchor, so it must be excluded too —
      // otherwise mousedown unmounts the popup before the option's click fires.
      if (listRef.current?.contains(target)) return
      onDismiss()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [anchorRef, onDismiss])

  if (!coords) return null

  return createPortal(
    <div
      ref={listRef}
      role="listbox"
      aria-label="Slash commands"
      className={cn(
        'fixed z-[200] flex flex-col overflow-hidden border border-[var(--basis-border)] bg-[var(--basis-canvas-bg)] shadow-xl',
        'rounded-[var(--basis-chat-shell-radius)]',
      )}
      style={{ left: coords.left, bottom: coords.bottom, width: coords.width, maxHeight: 260 }}
    >
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {commands.map((command, index) => {
          const active = index === activeIndex
          return (
            <button
              key={command.name}
              type="button"
              role="option"
              aria-selected={active}
              onMouseEnter={() => onActiveIndexChange(index)}
              // Keep focus in the textarea so accepting never blurs the composer.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onSelect(command)}
              className={cn(
                'flex w-full items-baseline gap-2 px-2.5 py-1 text-left transition-colors',
                'text-11-regular',
                active
                  ? 'bg-[var(--basis-surface-hover)] text-[var(--basis-text-strong)]'
                  : 'text-[var(--basis-text-muted)] hover:bg-[var(--basis-surface)] hover:text-[var(--basis-text)]',
              )}
            >
              <span className="shrink-0 font-medium text-[var(--basis-text)]">/{command.name}</span>
              {command.description && (
                <span className="min-w-0 flex-1 truncate text-[10px] leading-4 text-[var(--basis-text-faint)]">
                  {command.description}
                </span>
              )}
            </button>
          )
        })}
      </div>
    </div>,
    document.body,
  )
}
