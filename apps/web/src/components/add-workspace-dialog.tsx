import { useEffect, useId, useState, type FormEvent } from 'react'
import type { EnvironmentClient } from '@openmanager/environment-client'
import { cn } from '../lib/utils'

const fieldClass =
  'w-full rounded-md border border-[var(--basis-border)] bg-[var(--basis-surface)] px-3 py-1.5 font-mono text-ui-sm text-[var(--basis-text)] outline-none focus-visible:border-[var(--basis-border-strong)]'
const primaryButtonClass =
  'rounded-md bg-[var(--basis-action-bg)] px-3 py-1.5 text-ui-sm text-[var(--basis-action-fg)] hover:bg-[var(--basis-action-hover)] disabled:opacity-50'
const secondaryButtonClass =
  'rounded-md border border-[var(--basis-border)] bg-[var(--basis-surface)] px-3 py-1.5 text-ui-sm text-[var(--basis-text)] hover:bg-[var(--basis-surface-hover)] disabled:opacity-50'

/**
 * The browser has no picker for a folder on the environment host, so the
 * path is typed and the environment validates it: it must be an absolute
 * path to a folder that exists there. The environment's refusal is shown in
 * place, with the typed path kept, so a typo is a quick fix rather than a
 * fresh start.
 */
export function AddWorkspaceDialog({
  client,
  open,
  onClose,
}: {
  client: EnvironmentClient
  open: boolean
  onClose: () => void
}) {
  if (!open) return null
  return <AddWorkspaceForm client={client} onClose={onClose} />
}

function AddWorkspaceForm({ client, onClose }: { client: EnvironmentClient; onClose: () => void }) {
  const titleId = useId()
  const inputId = useId()
  const [path, setPath] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const trimmed = path.trim()
    if (!trimmed) {
      setError('Enter the path of a folder on the environment.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await client.commands.addWorkspace({ path: trimmed })
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose()
      }}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-md rounded-xl border border-[var(--basis-border)] bg-[var(--basis-canvas-bg)] p-5 shadow-[0_12px_34px_rgba(0,0,0,0.25)]"
        onSubmit={(event) => void submit(event)}
      >
        <h2 id={titleId} className="text-ui-base font-medium text-[var(--basis-text-strong)]">
          Add a project
        </h2>
        <p className="mt-1 text-ui-xs text-[var(--basis-text-muted)]">
          Type the absolute path of a folder on the machine running this environment. The
          environment checks that the folder exists before adding it.
        </p>
        <label className="mt-4 block text-ui-sm text-[var(--basis-text)]" htmlFor={inputId}>
          Folder path
        </label>
        <input
          id={inputId}
          name="path"
          type="text"
          autoFocus
          autoComplete="off"
          spellCheck={false}
          placeholder="C:\Users\you\project or /home/you/project"
          className={cn(fieldClass, 'mt-1.5')}
          value={path}
          disabled={busy}
          onChange={(event) => setPath(event.target.value)}
        />
        {error ? (
          <p className="mt-2 text-ui-xs text-[var(--basis-danger,#d33)]" role="alert">
            {error}
          </p>
        ) : null}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className={secondaryButtonClass} onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className={primaryButtonClass} disabled={busy}>
            {busy ? 'Adding…' : 'Add project'}
          </button>
        </div>
      </form>
    </div>
  )
}
