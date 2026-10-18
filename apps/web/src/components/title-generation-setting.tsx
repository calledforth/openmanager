import { useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { EnvironmentClient } from '@openmanager/environment-client'
import {
  DEFAULT_TITLE_GENERATION_MODELS,
  type TitleGenerationProvider,
  type TitleGenerationSetting,
} from '@openmanager/protocol'
import {
  ProviderModelPicker,
  type ProviderModelGroup,
} from '@openmanager/app-core/components/chat/ProviderModelPicker'
import { metadataModelOptions } from '@openmanager/app-core/components/chat/providerModelGroups'
import { Switch } from '@openmanager/app-core/components/fluid/ui/switch'
import {
  useConnectionState,
  useEnvironmentClientOptional,
} from '@openmanager/app-core/providers/environment-client'
import {
  ComposerStateContext,
  type ComposerStateValue,
} from '@openmanager/app-core/providers/composer-provider'
import { PlatformCapabilitiesContext } from '@openmanager/app-core/providers/platform-provider'

type TitleTool = Exclude<TitleGenerationProvider, 'off'>

export const TITLE_TOOL_LABELS: Record<TitleTool, string> = {
  claude: 'Claude',
  cursor: 'Cursor',
  opencode: 'OpenCode',
  codex: 'Codex',
}

/**
 * Tools whose session catalog names models the way their title CLI's
 * `--model` does: Claude Code's aliases (`opus`, `default`) and OpenCode's
 * `provider/model`. Cursor's session catalog says `grok-4.7` where
 * `cursor-agent --model` wants `grok-4.7-high`, and Codex has none, so their
 * models are typed as the CLI names them.
 */
const catalogFor = (tool: TitleTool) => (tool === 'claude' || tool === 'opencode' ? tool : null)

/** The tools in the picker's tab order. */
const TITLE_TOOLS: readonly TitleTool[] = ['claude', 'cursor', 'opencode', 'codex']

/** What turning titles on picks when nothing was picked before: the environment's own default. */
const FIRST_TOOL: TitleTool = 'codex'

/**
 * One group per tool. Each opens with its title default (an empty id, which
 * the environment reads as `DEFAULT_TITLE_GENERATION_MODELS`), then the models
 * the composer lists for it: the catalog its sessions reported, else the one
 * the environment's launch probe read, where those ids are ones the tool's CLI
 * takes. Any other model (Codex, Cursor, or a tool with no list) is typed.
 * A saved model no catalog lists still shows, so the picker can mark it.
 */
export function titleModelGroups(
  providers: Parameters<typeof metadataModelOptions>[0],
  profiles: ComposerStateValue['providerComposerProfiles'],
  saved: TitleGenerationSetting | null,
): ProviderModelGroup<TitleTool>[] {
  return TITLE_TOOLS.map((tool) => {
    const fallback = DEFAULT_TITLE_GENERATION_MODELS[tool]
    const catalog = catalogFor(tool)
    const fromSessions = !catalog
      ? []
      : (profiles[catalog]?.availableModels ?? []).map((model) => ({
          id: model.modelId,
          name: model.name,
          ...(model.description ? { description: model.description } : {}),
        }))
    const listed = !catalog
      ? []
      : fromSessions.length > 0
        ? fromSessions
        : metadataModelOptions(providers, catalog)
    const models = [
      {
        id: '',
        name: fallback ? `${fallback} (default)` : 'OpenCode default',
        description: fallback
          ? 'Small and fast, the usual pick for titles'
          : 'The model OpenCode is set to use',
      },
      ...listed,
    ]
    if (saved?.provider === tool && saved.model && !models.some((m) => m.id === saved.model)) {
      models.push({ id: saved.model, name: saved.model, description: 'Set by name' })
    }
    return {
      providerId: tool,
      providerName: TITLE_TOOL_LABELS[tool],
      models,
      // With no list to pick from, the model is typed: a typo there would
      // fail every title, so a listed tool takes only its listed models.
      ...(listed.length === 0 ? { acceptsTypedIds: true } : {}),
    }
  })
}

/**
 * Which CLI and model name this environment's sessions. The environment keeps
 * the choice for every client. Hidden until an environment is connected.
 */
export function TitleGenerationSettingControl({
  section,
}: {
  /** The settings section around the control, drawn only when there is one. */
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
  return section(<TitleGenerationForm client={client} />)
}

function TitleGenerationForm({ client }: { client: EnvironmentClient }) {
  const platform = useContext(PlatformCapabilitiesContext)
  const profiles = useContext(ComposerStateContext)?.providerComposerProfiles
  const [saved, setSaved] = useState<TitleGenerationSetting | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The tool and model in use before titles were turned off, to come back to.
  const lastOn = useRef<TitleGenerationSetting | null>(null)

  useEffect(() => {
    let live = true
    // Another environment's values must not show while this one's load.
    setSaved(null)
    setError(null)
    lastOn.current = null
    client.commands.getEnvironmentSettings().then(
      (settings) => {
        if (live) setSaved(settings.titleGeneration)
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
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const groups = useMemo(
    () => titleModelGroups(platform?.providers ?? [], profiles ?? {}, saved),
    [platform?.providers, profiles, saved],
  )

  // Until the environment's value is known, nothing may be picked: a pick
  // saves the whole setting, and would overwrite a model never shown.
  const notLoaded = saved === null
  const on = saved !== null && saved.provider !== 'off'
  const tool: TitleTool = on ? (saved.provider as TitleTool) : FIRST_TOOL

  const toggle = () => {
    if (!saved || busy) return
    if (on) {
      lastOn.current = saved
      void save({ provider: 'off', model: '' })
    } else {
      void save(lastOn.current ?? { provider: FIRST_TOOL, model: '' })
    }
  }

  return (
    <div className="mt-3">
      <div className="flex items-center gap-3 rounded-lg bg-hover/70 py-2 pl-3 pr-2">
        <Switch
          label="Generate titles"
          checked={on}
          disabled={notLoaded || busy}
          onToggle={toggle}
          className="min-w-0 flex-1"
        />
        {on ? (
          <ProviderModelPicker<TitleTool>
            groups={groups}
            currentProviderId={tool}
            currentModelId={saved.model}
            onChange={(provider, model) => void save({ provider, model })}
            disabled={busy}
            canChangeProvider
            placement="below"
            align="end"
            paletteEntry={false}
            triggerLabel="Title model"
          />
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="mt-2 text-[13px] text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}
