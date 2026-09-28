import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import type { EnvironmentClient } from '@openmanager/environment-client'
import {
  DEFAULT_TITLE_GENERATION_MODELS,
  TITLE_GENERATION_PROVIDERS,
  type TitleGenerationProvider,
  type TitleGenerationSetting,
} from '@openmanager/protocol'
import { Button } from '@openmanager/app-core/components/fluid/ui/button'
import {
  useConnectionState,
  useEnvironmentClientOptional,
} from '@openmanager/app-core/providers/environment-client'

const PROVIDER_LABELS: Record<TitleGenerationProvider, string> = {
  off: 'Off',
  codex: 'Codex',
  claude: 'Claude Code',
  cursor: 'Cursor',
  opencode: 'OpenCode',
}

export const TITLE_GENERATION_CHOICES = TITLE_GENERATION_PROVIDERS.map((id) => ({
  id,
  label: PROVIDER_LABELS[id],
}))

// The same quiet fill as the other environment fields; mono for a model id.
const fieldClass =
  'h-9 min-w-0 flex-1 rounded-lg bg-hover/70 px-3 font-mono text-[14px] outline-none transition-colors duration-100 placeholder:text-faint focus:bg-hover disabled:opacity-60'

/**
 * Which CLI and model name this environment's sessions. The environment keeps
 * the choice for every client. Hidden until an environment is connected.
 */
export function TitleGenerationSettingControl({
  section,
  choices,
}: {
  /** The settings section around the control, drawn only when there is one. */
  section: (field: ReactNode) => ReactNode
  /** The provider picker, drawn by the settings page in its own style. */
  choices: (
    value: TitleGenerationProvider,
    onChange: (provider: TitleGenerationProvider) => void,
    disabled: boolean,
  ) => ReactNode
}) {
  const client = useEnvironmentClientOptional()
  if (!client) return null
  return <ConnectedSetting client={client} section={section} choices={choices} />
}

type Choices = Parameters<typeof TitleGenerationSettingControl>[0]['choices']

function ConnectedSetting({
  client,
  section,
  choices,
}: {
  client: EnvironmentClient
  section: (field: ReactNode) => ReactNode
  choices: Choices
}) {
  // Re-render on handshake: what the environment supports is known only then.
  useConnectionState()
  if (!client.supports('getEnvironmentSettings')) return null
  return section(<TitleGenerationForm client={client} choices={choices} />)
}

function TitleGenerationForm({
  client,
  choices,
}: {
  client: EnvironmentClient
  choices: Choices
}) {
  const [saved, setSaved] = useState<TitleGenerationSetting | null>(null)
  const [model, setModel] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    // Another environment's values must not show while this one's load.
    setSaved(null)
    setModel('')
    setError(null)
    client.commands.getEnvironmentSettings().then(
      (settings) => {
        if (!live) return
        setSaved(settings.titleGeneration)
        setModel(settings.titleGeneration.model)
      },
      (err: unknown) => {
        if (live) setError(err instanceof Error ? err.message : String(err))
      },
    )
    return () => {
      live = false
    }
  }, [client])

  const save = async (next: TitleGenerationSetting) => {
    setBusy(true)
    setError(null)
    try {
      const settings = await client.commands.setEnvironmentSettings({ titleGeneration: next })
      setSaved(settings.titleGeneration)
      setModel(settings.titleGeneration.model)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (saved) void save({ ...saved, model: model.trim() })
  }

  const provider = saved?.provider ?? 'off'
  // Until the environment's value is known, nothing may be picked: a pick
  // saves the whole setting, and would overwrite a model never shown.
  const notLoaded = saved === null
  const changed = saved !== null && model.trim() !== saved.model

  return (
    <div className="mt-2">
      {/* A model id belongs to one tool, so switching tools starts on its default. */}
      {choices(provider, (next) => void save({ provider: next, model: '' }), notLoaded || busy)}
      {provider !== 'off' ? (
        <form className="mt-3 flex items-center gap-2" onSubmit={submit}>
          <input
            type="text"
            aria-label="Title model"
            autoComplete="off"
            spellCheck={false}
            placeholder={DEFAULT_TITLE_GENERATION_MODELS[provider] || 'OpenCode default model'}
            className={fieldClass}
            value={model}
            disabled={notLoaded || busy}
            onChange={(event) => {
              setError(null)
              setModel(event.target.value)
            }}
          />
          <Button type="submit" variant="secondary" disabled={!changed || busy}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
          {saved?.model ? (
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => void save({ provider, model: '' })}
            >
              Reset
            </Button>
          ) : null}
        </form>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-[13px] text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}
