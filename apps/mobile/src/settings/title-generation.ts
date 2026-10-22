import type { EnvironmentClient } from '@openmanager/environment-client'
import {
  metadataModelOptions,
  type ComposerStateValue,
  type PlatformCapabilitiesValue,
} from '@openmanager/app-core/logic'
import {
  DEFAULT_TITLE_GENERATION_MODELS,
  type TitleGenerationProvider,
  type TitleGenerationSetting,
} from '@openmanager/protocol'

/**
 * Which CLI and model name the environment's sessions: an environment
 * setting (`environment.settings.get` / `.set`), so every paired device sees
 * the same value. Web's control (`apps/web/src/components/title-generation-setting.tsx`)
 * on the phone: the same tools in the same order, the same default for a
 * first switch-on, and the same rule for which models a tool lists.
 */

export type TitleTool = Exclude<TitleGenerationProvider, 'off'>

/** The tools in web's tab order. */
export const TITLE_TOOLS: readonly TitleTool[] = ['claude', 'cursor', 'opencode', 'codex']

/** What turning titles on picks when nothing was picked before: the environment's own default. */
export const FIRST_TOOL: TitleTool = 'codex'

/**
 * Tools whose session catalog names models the way their title CLI's
 * `--model` does (Claude Code's aliases, OpenCode's `provider/model`).
 * Cursor's catalog ids are not the ones `cursor-agent --model` takes, and
 * Codex has none, so those two offer their default (and a model saved by
 * name elsewhere) only.
 */
const catalogFor = (tool: TitleTool) => (tool === 'claude' || tool === 'opencode' ? tool : null)

export type TitleModelChoice = { id: string; name: string; description?: string }

/**
 * A tool's models: its title default first (the empty id, which the
 * environment reads as `DEFAULT_TITLE_GENERATION_MODELS`), then what its
 * sessions reported, else what the environment's launch probe read. A saved
 * model no list names still shows, so it can be seen and kept.
 */
export function titleModels(
  tool: TitleTool,
  providers: PlatformCapabilitiesValue['providers'],
  profiles: ComposerStateValue['providerComposerProfiles'],
  saved: TitleGenerationSetting | null,
): TitleModelChoice[] {
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
      : metadataModelOptions(providers, catalog).map(({ id, name, description }) => ({
          id,
          name,
          ...(description ? { description } : {}),
        }))
  const models: TitleModelChoice[] = [
    {
      id: '',
      name: fallback ? `${fallback} (default)` : 'Default',
      description: fallback
        ? 'Small and fast, the usual pick for titles'
        : 'The model the tool is set to use',
    },
    ...listed,
  ]
  if (saved?.provider === tool && saved.model && !models.some((m) => m.id === saved.model)) {
    models.push({ id: saved.model, name: saved.model, description: 'Set by name' })
  }
  return models
}

/** The words under the setting's row: the model in use, or that titles are off. */
export function titleSummary(
  saved: TitleGenerationSetting | null,
  models: readonly TitleModelChoice[],
): string {
  if (!saved) return 'Loading…'
  if (saved.provider === 'off') return 'Off · sessions keep their first prompt as the title'
  return models.find((model) => model.id === saved.model)?.name ?? saved.model
}

export type TitleSettingState = {
  /** What the environment last answered; null before it first did. */
  saved: TitleGenerationSetting | null
  busy: boolean
  error: string | null
}

export interface TitleSetting {
  getState(): TitleSettingState
  subscribe(listener: () => void): () => void
  /** Save a whole setting; the state shows the environment's answer. */
  save(next: TitleGenerationSetting): Promise<boolean>
  /** Off, or back on with the tool and model in use before (else the first default). */
  toggle(): Promise<boolean>
  /** Read the environment's value; returns the stop. */
  start(): () => void
  dispose(): void
}

/**
 * The setting as the environment holds it. Until its value is known nothing
 * may be picked: a pick saves the whole setting and would overwrite a model
 * never shown. After a save the state is the environment's answer, not the
 * value sent.
 */
export function createTitleSetting(client: EnvironmentClient): TitleSetting {
  let state: TitleSettingState = { saved: null, busy: false, error: null }
  let disposed = false
  // The tool and model in use before titles were turned off, to come back to.
  let lastOn: TitleGenerationSetting | null = null
  const listeners = new Set<() => void>()
  const set = (patch: Partial<TitleSettingState>) => {
    if (disposed) return
    state = { ...state, ...patch }
    for (const listener of [...listeners]) listener()
  }
  const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

  let generation = 0

  const save = async (next: TitleGenerationSetting) => {
    if (state.busy || !state.saved) return false
    set({ busy: true, error: null })
    try {
      const settings = await client.commands.setEnvironmentSettings({ titleGeneration: next })
      set({ saved: settings.titleGeneration, busy: false })
      return true
    } catch (error) {
      set({ busy: false, error: message(error) })
      return false
    }
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    save,
    toggle() {
      const saved = state.saved
      if (!saved) return Promise.resolve(false)
      if (saved.provider !== 'off') {
        lastOn = saved
        return save({ provider: 'off', model: '' })
      }
      return save(lastOn ?? { provider: FIRST_TOOL, model: '' })
    },
    start() {
      if (disposed) return () => undefined
      const current = ++generation
      client.commands.getEnvironmentSettings().then(
        (settings) => {
          if (current === generation) set({ saved: settings.titleGeneration, error: null })
        },
        (error: unknown) => {
          if (current === generation) set({ error: message(error) })
        },
      )
      return () => {
        if (current === generation) generation += 1
      }
    },
    dispose() {
      disposed = true
      generation += 1
      listeners.clear()
    },
  }
}
