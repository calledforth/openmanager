import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import type { EnvironmentClient } from '@openmanager/environment-client'
import { Button } from '@openmanager/app-core/components/fluid/ui/button'
import {
  useConnectionState,
  useEnvironmentClientOptional,
} from '@openmanager/app-core/providers/environment-client'

// The add-project field's look: a quiet fill, mono because it holds a path.
const fieldClass =
  'h-9 min-w-0 flex-1 rounded-lg bg-hover/70 px-3 font-mono text-[14px] outline-none transition-colors duration-100 placeholder:text-faint focus:bg-hover disabled:opacity-60'

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
  return section(<StartFolderForm client={client} />)
}

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
        if (live) setError(err instanceof Error ? err.message : String(err))
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
      setError(err instanceof Error ? err.message : String(err))
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
