import { useCallback, useState, type FormEvent } from 'react'
import type { EnvironmentClient } from '@openmanager/environment-client'
import { AddProjectPalette } from '@openmanager/app-core/components/workspace/AddProjectPalette'
import { Button } from '@openmanager/app-core/components/fluid/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@openmanager/app-core/components/fluid/ui/dialog'

// Tend's connect field, in mono because it holds a path.
const fieldClass =
  'h-9 w-full rounded-lg bg-hover/70 px-3 font-mono text-[15px] outline-none transition-colors duration-100 placeholder:text-faint focus:bg-hover'

/**
 * Add project. An environment that lists its folders gets the folder
 * browser; an older one gets a typed path it validates: an absolute path to a
 * folder that exists there. Either way the environment's refusal is shown in
 * place, with what was typed kept, so a typo is a quick fix rather than a
 * fresh start. Once the environment has it, `onAdded` hears which project
 * it was, so the host can take the user straight to it.
 */
export function AddWorkspaceDialog({
  client,
  open,
  onClose,
  onAdded,
}: {
  client: EnvironmentClient
  open: boolean
  onClose: () => void
  onAdded?: (workspaceId: string) => void
}) {
  const browse = useCallback(
    (path?: string, prefix?: string) => client.commands.browseFolders(path, prefix),
    [client],
  )
  const add = useCallback(
    async (path: string) => {
      const workspace = await client.commands.addWorkspace({ path })
      onAdded?.(workspace.workspaceId)
    },
    [client, onAdded],
  )
  if (client.supports('browseFolders')) {
    return (
      <AddProjectPalette
        open={open}
        onOpenChange={(next) => {
          if (!next) onClose()
        }}
        browse={browse}
        onAdd={add}
      />
    )
  }
  return <AddWorkspacePathDialog client={client} open={open} onClose={onClose} onAdded={onAdded} />
}

function AddWorkspacePathDialog({
  client,
  open,
  onClose,
  onAdded,
}: {
  client: EnvironmentClient
  open: boolean
  onClose: () => void
  onAdded?: (workspaceId: string) => void
}) {
  // While the environment is answering, the dialog stays so the outcome has
  // somewhere to land; the request itself cannot be cancelled. Busy lives up
  // here so Escape, the scrim and the corner ✕ are all held off in one place;
  // the form's own state resets with the panel.
  const [busy, setBusy] = useState(false)
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose()
      }}
    >
      <DialogContent showCloseButton={!busy}>
        <AddWorkspaceForm
          client={client}
          busy={busy}
          setBusy={setBusy}
          onClose={onClose}
          onAdded={onAdded}
        />
      </DialogContent>
    </Dialog>
  )
}

function AddWorkspaceForm({
  client,
  busy,
  setBusy,
  onClose,
  onAdded,
}: {
  client: EnvironmentClient
  busy: boolean
  setBusy: (busy: boolean) => void
  onClose: () => void
  onAdded?: (workspaceId: string) => void
}) {
  const [path, setPath] = useState('')
  const [error, setError] = useState<string | null>(null)

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
      const workspace = await client.commands.addWorkspace({ path: trimmed })
      setBusy(false)
      onClose()
      onAdded?.(workspace.workspaceId)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)}>
      <DialogHeader>
        <DialogTitle>Add a project</DialogTitle>
        <DialogDescription>
          Type the absolute path of a folder on the machine running this environment. The
          environment checks that the folder exists before adding it.
        </DialogDescription>
      </DialogHeader>
      <input
        name="path"
        type="text"
        autoFocus
        autoComplete="off"
        spellCheck={false}
        placeholder="C:\Users\you\project or /home/you/project"
        aria-label="Folder path"
        className={fieldClass}
        value={path}
        disabled={busy}
        onChange={(event) => setPath(event.target.value)}
      />
      {error ? (
        <p className="mt-2 text-[13px] text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" variant="secondary" disabled={busy}>
          {busy ? 'Adding…' : 'Add project'}
        </Button>
      </DialogFooter>
    </form>
  )
}
