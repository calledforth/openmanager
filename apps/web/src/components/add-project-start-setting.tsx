import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import {
  ArrowCounterClockwiseIcon,
  FolderSimpleIcon,
  PencilSimpleIcon,
} from '@phosphor-icons/react'
import type { EnvironmentClient } from '@openmanager/environment-client'
import { Button } from '@openmanager/app-core/components/fluid/ui/button'
import { Tooltip } from '@openmanager/app-core/components/ui/Tooltip'
import {
  AddProjectPalette,
  type FolderPaletteLabels,
} from '@openmanager/app-core/components/workspace/AddProjectPalette'
import {
  useConnectionState,
  useEnvironmentClientOptional,
} from '@openmanager/app-core/providers/environment-client'

// The add-project field's look: a quiet fill, mono because it holds a path.
const fieldClass =
  'h-9 min-w-0 flex-1 rounded-lg bg-hover/70 px-3 font-mono text-[14px] outline-none transition-colors duration-100 placeholder:text-faint focus:bg-hover disabled:opacity-60'

/** Add project's own folder browser, worded for choosing where it starts. */
const START_FOLDER_LABELS: FolderPaletteLabels = {
  title: 'Where Add project starts',
  description: 'Browse the environment’s folders and pick the one Add project opens in.',
  action: (name) => `Start in ${name}`,
  idle: 'Choose folder',
  busy: 'Saving…',
  emptyFolder: 'No folders inside. Enter picks this one.',
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * Where Add project's folder browser opens. The environment keeps it, so
 * every client of that environment opens in the same place, and it checks
 * the folder exists before saving. Hidden until an environment that has the
 * setting is connected.
 */
export function AddProjectStartSetting({
  section,
}: {
  /** The settings section around the field, drawn only when there is a field. */
  section: (field: ReactNode) => ReactNode
}) {
  const client = useEnvironmentClientOptional()
  if (!client) return null
  return <ConnectedSetting client={client} section={section} />
}

function ConnectedSetting({
  client,
  section,
}: {
  client: EnvironmentClient
  section: (field: ReactNode) => ReactNode
}) {
  // Re-render on handshake: what the environment supports is known only then.
  useConnectionState()
  if (!client.supports('getEnvironmentSettings')) return null
  // An environment that cannot list its folders can only be told a path.
  if (!client.supports('browseFolders')) return section(<StartFolderForm client={client} />)
  return section(<StartFolderPicker client={client} />)
}

/**
 * The folder as a row: pressing it opens the same browser Add project uses,
 * started where the setting points. With nothing set, the row shows the
 * folder that stands in for it (the home folder), as the environment names it.
 */
function StartFolderPicker({ client }: { client: EnvironmentClient }) {
  const [saved, setSaved] = useState<string | null>(null)
  // Where the browser opens today, as a real path: the saved folder, or home.
  const [resolved, setResolved] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Only the latest lookup of the home folder may land: an older one may be
  // another environment's, or from before the setting changed.
  const lookup = useRef(0)

  const resolve = useCallback(() => {
    const current = ++lookup.current
    return client.commands.browseFolders().then(
      (listing) => {
        if (current === lookup.current) setResolved(listing.path)
      },
      () => {
        if (current === lookup.current) setResolved(null)
      },
    )
  }, [client])

  useEffect(() => {
    let live = true
    // Another environment's folder must not show while this one's loads.
    lookup.current += 1
    setSaved(null)
    setResolved(null)
    setError(null)
    client.commands.getEnvironmentSettings().then(
      (settings) => {
        if (!live) return
        setSaved(settings.addProjectStartsIn)
        void resolve()
      },
      (err: unknown) => {
        if (live) setError(messageOf(err))
      },
    )
    return () => {
      live = false
      lookup.current += 1
    }
  }, [client, resolve])

  const browse = useCallback(
    (path?: string, prefix?: string) => client.commands.browseFolders(path, prefix),
    [client],
  )

  // A refusal is thrown back to the browser, which shows it in place.
  const choose = useCallback(
    async (path: string) => {
      const settings = await client.commands.setEnvironmentSettings({ addProjectStartsIn: path })
      setError(null)
      setSaved(settings.addProjectStartsIn)
      if (settings.addProjectStartsIn) {
        lookup.current += 1
        setResolved(settings.addProjectStartsIn)
      } else {
        setResolved(null)
        void resolve()
      }
    },
    [client, resolve],
  )

  const reset = async () => {
    setBusy(true)
    setError(null)
    try {
      await choose('')
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setBusy(false)
    }
  }

  const loading = saved === null
  const shown = saved || resolved
  return (
    <div className="mt-3">
      <div className="flex items-center gap-1">
        <button
          type="button"
          disabled={loading || busy}
          aria-label={`Add project starts in ${shown ?? 'the home folder'}. Change`}
          onClick={() => {
            setError(null)
            setOpen(true)
          }}
          className="group/folder flex h-9 min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-lg bg-hover/70 px-3 text-left outline-none transition-colors duration-100 hover:bg-hover focus-visible:ring-1 focus-visible:ring-focus-ring disabled:cursor-default disabled:opacity-60"
        >
          <FolderSimpleIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate font-mono text-[13px] text-foreground">
            {loading ? 'Loading…' : (shown ?? '~')}
          </span>
          {!loading && !saved ? (
            <span className="shrink-0 text-[12px] text-faint">Home</span>
          ) : null}
          <PencilSimpleIcon
            aria-hidden
            className="ml-auto size-3.5 shrink-0 text-faint transition-colors duration-100 group-hover/folder:text-muted-foreground"
          />
        </button>
        {saved ? (
          <Tooltip content="Start in the home folder">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Start in the home folder"
              disabled={busy}
              onClick={() => void reset()}
            >
              <ArrowCounterClockwiseIcon />
            </Button>
          </Tooltip>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="mt-2 text-[13px] text-destructive">
          {error}
        </p>
      ) : null}
      <AddProjectPalette
        open={open}
        onOpenChange={setOpen}
        browse={browse}
        onAdd={choose}
        labels={START_FOLDER_LABELS}
      />
    </div>
  )
}

/** A typed path, for an environment that cannot list its folders. */
function StartFolderForm({ client }: { client: EnvironmentClient }) {
  const [saved, setSaved] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    client.commands.getEnvironmentSettings().then(
      (settings) => {
        if (!live) return
        setSaved(settings.addProjectStartsIn)
        setDraft(settings.addProjectStartsIn)
      },
      (err: unknown) => {
        if (live) setError(messageOf(err))
      },
    )
    return () => {
      live = false
    }
  }, [client])

  const save = async (value: string) => {
    setBusy(true)
    setError(null)
    try {
      const settings = await client.commands.setEnvironmentSettings({ addProjectStartsIn: value })
      setSaved(settings.addProjectStartsIn)
      setDraft(settings.addProjectStartsIn)
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setBusy(false)
    }
  }

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    void save(draft.trim())
  }

  const loading = saved === null && error === null
  const changed = saved !== null && draft.trim() !== saved

  return (
    <form className="mt-3" onSubmit={submit}>
      <div className="flex items-center gap-2">
        <input
          type="text"
          aria-label="Add project starts in"
          autoComplete="off"
          spellCheck={false}
          placeholder="~"
          className={fieldClass}
          value={draft}
          disabled={loading || busy}
          onChange={(event) => {
            setError(null)
            setDraft(event.target.value)
          }}
        />
        <Button type="submit" variant="secondary" disabled={!changed || busy}>
          {busy ? 'Saving…' : 'Save'}
        </Button>
        {saved ? (
          <Button type="button" variant="ghost" disabled={busy} onClick={() => void save('')}>
            Reset
          </Button>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="mt-2 text-[13px] text-destructive">
          {error}
        </p>
      ) : null}
    </form>
  )
}
