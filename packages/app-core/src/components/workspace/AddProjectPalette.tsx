import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { ArrowUpIcon, FolderSimpleIcon } from '@phosphor-icons/react'
import type { FilesystemListing } from '@openmanager/environment-client'
import { Button } from '../fluid/ui/button'
import {
  CommandMenu,
  CommandMenuDialog,
  CommandMenuEmpty,
  CommandMenuInput,
  CommandMenuItem,
  CommandMenuList,
  CommandMenuShortcut,
  type CommandMenuItemData,
} from '../fluid/ui/command-menu'
import { phosphorIcon } from '../fluid/lib/icon-context'
import {
  addTarget,
  asFolderInput,
  folderName,
  splitBrowseInput,
  visibleFolders,
} from './folder-browser'

const FolderIcon = phosphorIcon(FolderSimpleIcon)

export interface AddProjectPaletteProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Lists a folder on the environment; no path lists where Add project starts. */
  browse: (path?: string) => Promise<FilesystemListing>
  /** Registers the folder. A rejection is shown in place and the palette stays open. */
  onAdd: (path: string) => Promise<void>
}

/**
 * Add project as a folder browser, after T3 Code's: the field is a path on
 * the environment's machine, the rows are the folders inside the part typed
 * so far, and the text after the last separator narrows them. Enter steps
 * into the highlighted folder; Ctrl/⌘+Enter adds the one the field names.
 */
export function AddProjectPalette({ open, onOpenChange, browse, onAdd }: AddProjectPaletteProps) {
  // Adding holds the palette open, so the outcome has somewhere to land.
  const [busy, setBusy] = useState(false)
  const setOpen = useCallback(
    (next: boolean) => {
      if (!next && busy) return
      onOpenChange(next)
    },
    [busy, onOpenChange],
  )
  return (
    <CommandMenuDialog
      title="Add a project"
      description="Browse the environment's folders and add one as a project."
      open={open}
      onOpenChange={setOpen}
      shortcut={null}
      className="max-w-[640px]"
    >
      <FolderBrowser
        browse={browse}
        onAdd={onAdd}
        busy={busy}
        setBusy={setBusy}
        close={() => onOpenChange(false)}
      />
    </CommandMenuDialog>
  )
}

type Listed = { ok: true; listing: FilesystemListing } | { ok: false; message: string }

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))
const passAll = () => true

function FolderBrowser({
  browse,
  onAdd,
  busy,
  setBusy,
  close,
}: Pick<AddProjectPaletteProps, 'browse' | 'onAdd'> & {
  busy: boolean
  setBusy: (busy: boolean) => void
  close: () => void
}) {
  const [query, setQuery] = useState('')
  // Every folder listed while the palette is open, by the spelling the field
  // used for it, so stepping back into one is instant.
  const [listed, setListed] = useState<Record<string, Listed>>({})
  const requested = useRef(new Set<string>())
  const [started, setStarted] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)

  const remember = useCallback((key: string, result: Listed) => {
    setListed((current) => ({ ...current, [key]: result }))
  }, [])

  // Open where Add project starts, and show that folder's real path.
  useEffect(() => {
    let live = true
    browse().then(
      (listing) => {
        if (!live) return
        const input = asFolderInput(listing.path)
        requested.current.add(input)
        remember(input, { ok: true, listing })
        setQuery((current) => (current === '' ? input : current))
        setStarted(true)
      },
      (error: unknown) => {
        if (!live) return
        setAddError(messageOf(error))
        setStarted(true)
      },
    )
    return () => {
      live = false
    }
  }, [browse, remember])

  const { folder, filter } = splitBrowseInput(query)

  // List the folder the field names, once per spelling. A listing that
  // arrives after the field has moved on is still kept for later.
  useEffect(() => {
    if (!started || folder === null || requested.current.has(folder)) return
    requested.current.add(folder)
    browse(folder).then(
      (listing) => remember(folder, { ok: true, listing }),
      (error: unknown) => remember(folder, { ok: false, message: messageOf(error) }),
    )
  }, [browse, folder, started, remember])

  // While the next folder loads, the last one stays up rather than flashing
  // empty; nothing acts on it until the field's own folder has arrived.
  const current = folder === null ? undefined : listed[folder]
  const [shownFolder, setShownFolder] = useState<string | null>(null)
  if (current && folder !== shownFolder) setShownFolder(folder)
  const shown =
    current ?? (folder === null || shownFolder === null ? undefined : listed[shownFolder])
  const listing = current?.ok ? current.listing : null

  const items = useMemo<CommandMenuItemData[]>(() => {
    if (!shown?.ok) return []
    return visibleFolders(shown.listing.entries, current ? filter : '').map((entry) => ({
      value: entry.path,
      label: entry.name,
      icon: FolderIcon,
      action: `Open ${entry.name}`,
      keepOpen: true,
      onSelect: () => {
        setAddError(null)
        setQuery(asFolderInput(entry.path))
      },
    }))
  }, [shown, current, filter])

  const target = listing ? addTarget(listing, filter) : null

  const add = async () => {
    if (busy || !target) return
    setBusy(true)
    setAddError(null)
    try {
      await onAdd(target)
      setBusy(false)
      close()
    } catch (error) {
      setAddError(messageOf(error))
      setBusy(false)
    }
  }

  const up = () => {
    if (!listing?.parentPath) return
    setAddError(null)
    setQuery(asFolderInput(listing.parentPath))
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return
    // With no rows there is nothing to step into, so Enter adds.
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey || items.length === 0)) {
      event.preventDefault()
      void add()
    } else if (event.key === 'ArrowUp' && event.altKey) {
      event.preventDefault()
      up()
    }
  }

  let empty: string
  if (!started) empty = 'Loading…'
  else if (folder === null) empty = 'Type a folder path, starting with ~, / or a drive like C:\\.'
  else if (!shown) empty = 'Loading…'
  else if (!shown.ok) empty = shown.message
  else if (!shown.listing.readable) empty = 'This folder cannot be opened.'
  else if (filter && current) empty = `No folder here starts with “${filter}”.`
  else empty = 'No folders inside. Enter adds this one.'

  return (
    <CommandMenu
      items={items}
      filter={passAll}
      query={query}
      onQueryChange={(next) => {
        setAddError(null)
        setQuery(next)
      }}
    >
      <div className="flex shrink-0 items-center pl-2.5">
        <Button
          type="button"
          variant="ghost"
          size="icon-compact"
          aria-label="Parent folder"
          title="Parent folder (Alt+↑)"
          disabled={!listing?.parentPath || busy}
          // Keep the field focused: the palette is driven from the keyboard.
          onMouseDown={(event) => event.preventDefault()}
          onClick={up}
        >
          <ArrowUpIcon />
        </Button>
        <CommandMenuInput
          icon={null}
          aria-label="Folder path"
          placeholder="~/ or C:\"
          disabled={busy}
          onKeyDown={onKeyDown}
          className="text-[15px] leading-6"
        />
      </div>
      {addError ? (
        <p role="alert" className="shrink-0 px-4 pb-2 text-[13px] text-destructive">
          {addError}
        </p>
      ) : null}
      <CommandMenuList
        className="gap-0 px-1.5 pb-1.5 pt-0.5"
        renderItem={(item) => (
          <CommandMenuItem value={item.value} className="h-9 gap-3 px-3 text-[14px]" />
        )}
      >
        <CommandMenuEmpty>{empty}</CommandMenuEmpty>
      </CommandMenuList>
      <div className="flex h-11 shrink-0 items-center gap-4 px-4 text-[12px] text-muted-foreground">
        <span className="flex items-center gap-1.5">
          Open <CommandMenuShortcut keys="enter" className="ml-0" />
        </span>
        <span className="flex items-center gap-1.5">
          Up <CommandMenuShortcut keys="alt+up" className="ml-0" />
        </span>
        <Button
          type="button"
          variant="secondary"
          size="compact"
          className="ml-auto min-w-0 max-w-[60%]"
          disabled={!target || busy}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => void add()}
        >
          <span className="truncate">
            {busy ? 'Adding…' : target ? `Add ${folderName(target)}` : 'Add project'}
          </span>
          <CommandMenuShortcut keys="mod+enter" className="ml-1" />
        </Button>
      </div>
    </CommandMenu>
  )
}
