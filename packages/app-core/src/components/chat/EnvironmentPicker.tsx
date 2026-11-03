import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CaretDownIcon, CheckIcon, HardDrivesIcon } from '@phosphor-icons/react'
import type { EnvironmentOption } from '../../providers/sidebar-provider'
import { cn } from '../../lib/utils'
import {
  CommandMenu,
  CommandMenuEmpty,
  CommandMenuInput,
  CommandMenuItem,
  CommandMenuList,
  type CommandMenuItemData,
} from '../fluid/ui/command-menu'
import { useHoldFocus } from '../command/pickerRegistry'
import { Tooltip } from '../ui/Tooltip'
import { usePortaledMenu } from '../ui/usePortaledMenu'

const MENU_WIDTH = 300

/**
 * The new session page's choice of machine, in the same menu as the project
 * picker above it, under the small line that names the environment. A choice
 * that cannot be reached stays listed so its absence reads as a fact, not as
 * a missing machine, and it cannot be picked.
 */
export function EnvironmentPicker({
  environments,
  selectedId,
  disabled = false,
  onSelect,
}: {
  environments: readonly EnvironmentOption[]
  /** The environment this page is on. */
  selectedId: string
  /** A session is starting from this page. */
  disabled?: boolean
  onSelect: (environmentId: string) => void
}) {
  const [query, setQuery] = useState('')
  const { open, toggle, close, menuCoords, wrapRef, triggerRef, menuRef } = usePortaledMenu({
    placement: 'below',
    minWidth: MENU_WIDTH,
    align: 'center',
  })
  const selected = environments.find(({ environmentId }) => environmentId === selectedId)
  const label = selected?.label ?? selectedId

  const items = useMemo<CommandMenuItemData[]>(
    () =>
      environments.map(({ environmentId, label, detail, reachable }) => {
        const usable = reachable || environmentId === selectedId
        const description = [detail, usable ? undefined : 'Not connected']
          .filter(Boolean)
          .join(' · ')
        return {
          value: environmentId,
          label,
          ...(description ? { description } : {}),
          ...(detail ? { keywords: [detail] } : {}),
          ...(usable ? {} : { disabled: true }),
        }
      }),
    [environments, selectedId],
  )

  useEffect(() => {
    if (!open) setQuery('')
  }, [open])

  const searchRef = useRef<HTMLInputElement>(null)
  useLayoutEffect(() => {
    if (open && menuCoords) searchRef.current?.focus()
  }, [open, menuCoords])

  const releaseFocus = useHoldFocus(open, menuRef, searchRef)

  const dismiss = useCallback(() => {
    releaseFocus()
    close()
    triggerRef.current?.focus()
  }, [releaseFocus, close, triggerRef])

  const pick = (environmentId: string) => {
    releaseFocus()
    close()
    if (environmentId !== selectedId) onSelect(environmentId)
  }

  const menu =
    open &&
    menuCoords &&
    createPortal(
      <div
        ref={menuRef}
        role="dialog"
        aria-label="Choose an environment"
        className="fixed z-[200] flex max-h-[min(400px,60vh)] flex-col overflow-hidden rounded-float bg-float text-left shadow-float"
        style={{ left: menuCoords.left, top: menuCoords.top, width: menuCoords.width }}
      >
        <CommandMenu
          items={items}
          query={query}
          onQueryChange={setQuery}
          onSelect={(item) => pick(item.value)}
          defaultHighlight={selectedId}
        >
          <CommandMenuInput
            ref={searchRef}
            placeholder="Search environments…"
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return
              event.preventDefault()
              dismiss()
            }}
          />
          <CommandMenuList
            className="gap-0 px-1.5 pb-1.5 pt-0.5"
            renderItem={(item) => <EnvironmentRow item={item} active={item.value === selectedId} />}
          >
            <CommandMenuEmpty>No environments</CommandMenuEmpty>
          </CommandMenuList>
        </CommandMenu>
      </div>,
      document.body,
    )

  return (
    <div ref={wrapRef} className="relative inline-flex min-w-0 max-w-[240px]">
      <Tooltip content={`Sessions run on ${label}`} side="bottom">
        <button
          ref={triggerRef}
          type="button"
          onClick={toggle}
          disabled={disabled}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={`Environment: ${label}. Choose an environment`}
          className={cn(
            'inline-flex min-w-0 max-w-full items-center gap-1 rounded-md border-0 bg-transparent px-1 py-0.5 text-[var(--basis-text-faint)] transition-colors',
            'hover:bg-hover hover:text-[var(--basis-text-muted)] disabled:pointer-events-none',
            open && 'bg-hover text-[var(--basis-text-muted)]',
          )}
        >
          <HardDrivesIcon weight="light" aria-hidden className="h-3 w-3 shrink-0" />
          <span className="truncate">{label}</span>
          <CaretDownIcon
            weight="light"
            aria-hidden
            className={cn('h-3 w-3 shrink-0 transition-transform', open && 'rotate-180')}
          />
        </button>
      </Tooltip>
      {menu}
    </div>
  )
}

function EnvironmentRow({ item, active }: { item: CommandMenuItemData; active: boolean }) {
  return (
    <CommandMenuItem value={item.value} className="h-9 gap-2.5 px-2.5 text-[13px] text-foreground">
      <HardDrivesIcon
        weight="light"
        aria-hidden
        className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
      />
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className="shrink-0 truncate">{item.label}</span>
        {item.description && (
          <span className="min-w-0 truncate text-muted-foreground/70">{item.description}</span>
        )}
      </span>
      <span className="flex w-3.5 shrink-0 justify-center">
        {active && (
          <CheckIcon aria-label="Current environment" size={14} className="text-foreground" />
        )}
      </span>
    </CommandMenuItem>
  )
}
