import { useState, type FormEvent } from 'react'
import { Button } from '@openmanager/app-core/components/fluid/ui/button'

// The same quiet fill as the other settings fields.
const fieldClass =
  'h-7 min-w-0 flex-1 rounded-md bg-hover px-2 text-[13px] text-foreground outline-none transition-colors duration-100 placeholder:text-faint focus:bg-active disabled:opacity-60'

/**
 * Edit a name in place: a device's, or an environment's. Saving the name it
 * already has, or pressing Escape, just closes it; a blank one cannot be saved.
 */
export function RenameForm({
  label,
  fieldLabel,
  maxLength,
  busy,
  onCancel,
  onSave,
}: {
  label: string
  /** What the field is called for assistive tech, e.g. "Device name". */
  fieldLabel: string
  maxLength: number
  busy: boolean
  onCancel: () => void
  onSave: (label: string) => void
}) {
  const [value, setValue] = useState(label)
  const trimmed = value.trim()
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!trimmed) return
    if (trimmed === label) onCancel()
    else onSave(trimmed)
  }
  return (
    <form className="flex min-w-0 flex-1 items-center gap-1.5" onSubmit={submit}>
      <input
        type="text"
        aria-label={fieldLabel}
        autoComplete="off"
        spellCheck={false}
        // Focus belongs in the field the person just asked to edit.
        autoFocus
        maxLength={maxLength}
        className={fieldClass}
        value={value}
        disabled={busy}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            onCancel()
          }
        }}
      />
      <Button type="submit" variant="secondary" size="compact" disabled={busy || !trimmed}>
        {busy ? 'Saving…' : 'Save'}
      </Button>
      <Button type="button" variant="ghost" size="compact" disabled={busy} onClick={onCancel}>
        Cancel
      </Button>
    </form>
  )
}
