import type { ModelInfo, PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import type {
  ModeListing,
  ModelListing,
  ModeOption,
  ModelOption,
  SessionConfigOption,
} from '@agentpack/contract'

/** Claude Code's permission modes, as a catalog the composer can render.
 *
 * Unlike models, this list is NOT on the wire. `initialize` answers commands,
 * models, agents and output styles, but never modes — the CLI's own picker is
 * built from a compiled-in union, and `PermissionMode` is that union. So this
 * file is the catalog, and it is the one hand-maintained list in the provider.
 * That is only defensible because the SDK's type makes drift a *compile* error:
 * a mode added to `PermissionMode` and not to `MODE_DETAIL` fails to build.
 *
 * Descriptions are the SDK's own doc comments, condensed. They matter more here
 * than they do for models: `dontAsk` and `auto` are not self-explanatory, and
 * choosing wrong silently changes whether a tool call can run at all. */
const MODE_DETAIL: Record<PermissionMode, { displayName: string; description: string }> = {
  default: {
    displayName: 'Default',
    description: 'Asks before anything dangerous.',
  },
  acceptEdits: {
    displayName: 'Accept edits',
    description: 'Auto-accepts file edits; still asks for everything else.',
  },
  plan: {
    displayName: 'Plan',
    description: 'Explores and proposes a plan. Runs no tools.',
  },
  auto: {
    displayName: 'Auto',
    description: 'A model classifier approves or denies each prompt.',
  },
  dontAsk: {
    displayName: "Don't ask",
    description: 'Never prompts — denies anything not already pre-approved.',
  },
  bypassPermissions: {
    displayName: 'Bypass permissions',
    description: 'Runs every tool without asking. Use with care.',
  },
}

/** Ordered least- to most-privileged. `default` leads deliberately: the
 * composer falls back to the first entry whenever it has no better answer, so
 * the first entry had better be the safe one. `bypassPermissions` is last for
 * the same reason. */
export const CLAUDE_PERMISSION_MODES: readonly PermissionMode[] = [
  'default',
  'acceptEdits',
  'plan',
  'auto',
  'dontAsk',
  'bypassPermissions',
]

/** The composer-facing catalog. Static, so the probe answers it without a
 * session and the mode picker renders before Claude has ever been run — the
 * same reason the model catalog is hoisted onto provider metadata. */
export const CLAUDE_MODE_OPTIONS: readonly ModeOption[] = CLAUDE_PERMISSION_MODES.map(
  (mode): ModeOption => ({ id: mode, ...MODE_DETAIL[mode] }),
)

/** What a session runs in when the composer asked for nothing. Matches the
 * SDK's own default for `Options.permissionMode`. */
export const CLAUDE_DEFAULT_MODE: PermissionMode = 'default'

/** Narrow an opaque composer string to a mode the CLI accepts.
 *
 * Refused here rather than sent on: `setPermissionMode` rejects an unknown mode
 * asynchronously, with the turn already dispatched. */
export function claudePermissionMode(modeId: string | undefined): PermissionMode | undefined {
  return CLAUDE_PERMISSION_MODES.find((mode) => mode === modeId)
}

/** The catalog plus whichever mode is currently in force, narrowed to what the
 * given model supports. Omit the model — as the probe does, before anything is
 * selected — to get the unfiltered list. */
export function claudeModeListing(currentModeId?: string, model?: ModelOption): ModeListing {
  return {
    availableModes: claudeModeOptionsFor(model),
    ...(currentModeId ? { currentModeId } : {}),
  }
}

/** `ModelInfo[]` from the handshake, narrowed to what the composer shows.
 *
 * `models` is non-optional in the SDK's own types, but the response comes off
 * a wire from whatever `claude` binary is on this machine — a CLI old enough
 * to predate the field sends nothing, and a runtime `undefined` through a
 * `.map()` would fail the whole probe over a model list. An empty catalog is
 * the honest answer there; guessing one is how you offer a model the CLI will
 * reject. `contextWindowTokens` is left unset because `ModelInfo` carries no
 * window size to set it from.
 *
 * The CLI puts the *marketing* name in `description`, not `displayName`:
 * `{displayName: 'Opus', description: 'Opus 5 · Best for everyday, complex
 * tasks · ~2× usage vs Sonnet'}`. Both are carried through — the picker needs
 * the second one to tell "Opus" from "Opus 5", and to explain what the
 * `default` row currently resolves to. */
export function claudeModelCatalog(models: readonly ModelInfo[] | undefined): ModelOption[] {
  return (models ?? []).map((model) => ({
    id: model.value,
    displayName: model.displayName,
    ...(model.description ? { description: model.description } : {}),
    ...(model.resolvedModel ? { resolvedModel: model.resolvedModel } : {}),
    // `supportsEffort` and the level list disagree on older CLIs; the list is
    // what the setter actually accepts, so it is the one carried. A model with
    // no levels has no effort control, which is a real state — Haiku reports
    // none at all.
    ...(model.supportsEffort && model.supportedEffortLevels?.length
      ? { effortLevels: [...model.supportedEffortLevels] }
      : {}),
    ...(model.supportsFastMode ? { supportsFastMode: true } : {}),
    ...(model.supportsAutoMode ? { supportsAutoMode: true } : {}),
  }))
}

/** The modes this *model* can actually run in.
 *
 * Not cosmetic filtering: the CLI rejects `setPermissionMode('auto')` outright
 * on a model without classifier support — verified against 2.1.220, where
 * `haiku + auto` fails with "auto mode unavailable for this model" while all
 * five other modes succeed. Offering it would turn a mode switch into an error
 * toast. Every other mode is model-independent.
 *
 * An unknown model (nothing selected yet, or a row this catalog has never
 * seen) keeps the full list: hiding a mode because we could not confirm it is
 * how a working control disappears. */
export function claudeModeOptionsFor(model: ModelOption | undefined): ModeOption[] {
  if (model && !model.supportsAutoMode)
    return CLAUDE_MODE_OPTIONS.filter((mode) => mode.id !== 'auto')
  return [...CLAUDE_MODE_OPTIONS]
}

/** The catalog plus whichever model is currently in force. */
export function claudeModelListing(
  models: readonly ModelInfo[] | undefined,
  currentModelId?: string,
): ModelListing {
  return {
    availableModels: claudeModelCatalog(models),
    ...(currentModelId ? { currentModelId } : {}),
  }
}

/** The CLI's "let Claude choose" alias row. Present in every catalog the
 * current CLI reports, and what a session runs under when nothing passed
 * `options.model`. */
export const CLAUDE_DEFAULT_MODEL_ID = 'default'

/** Config ids the composer and the runtime agree on. Strings rather than an
 * enum because they cross an IPC boundary as opaque keys. */
export const CLAUDE_CONFIG = {
  effort: 'effort',
  fastMode: 'fast_mode',
  outputStyle: 'output_style',
} as const

/** Effort levels are worth spelling out: the CLI's ids are terse and `xhigh`
 * versus `max` is not self-evident. Kept in the SDK's own order, cheapest
 * first, because that is the order the level list arrives in. */
const EFFORT_DETAIL: Record<string, string> = {
  low: 'Minimal thinking, fastest responses',
  medium: 'Moderate thinking',
  high: 'Deep reasoning',
  xhigh: 'Deeper than high',
  max: 'Maximum effort. Session-scoped — never persisted.',
}

/** The per-session settings Claude Code exposes beyond model and mode.
 *
 * All three ride the generic `SessionConfigOption` channel rather than getting
 * bespoke contract fields, because that channel already carries exactly what
 * they need: per-workspace persistence, re-application at launch, and a
 * renderer that knows how to draw a select and a switch.
 *
 * `effort` is emitted only when the selected model has levels — Haiku has
 * none, and a picker offering "high" on a model that ignores it is a lie. Fast
 * mode is likewise gated on the model, since the flag is global but its effect
 * is not. */
export function claudeConfigOptions(args: {
  model: ModelOption | undefined
  effort: string | undefined
  fastMode: boolean
  outputStyle: string | undefined
  outputStyles: readonly string[]
}): SessionConfigOption[] {
  const options: SessionConfigOption[] = []
  const levels = args.model?.effortLevels ?? []
  if (levels.length > 0)
    options.push({
      type: 'select',
      id: CLAUDE_CONFIG.effort,
      name: 'Reasoning effort',
      category: 'effort',
      description: 'How much thinking Claude puts into each response.',
      currentValue: levels.includes(args.effort ?? '') ? (args.effort as string) : '',
      options: levels.map((level) => ({
        value: level,
        name: level,
        ...(EFFORT_DETAIL[level] ? { description: EFFORT_DETAIL[level] } : {}),
      })),
    })
  if (args.model?.supportsFastMode)
    options.push({
      type: 'boolean',
      id: CLAUDE_CONFIG.fastMode,
      name: 'Fast mode',
      category: 'fast_mode',
      description: 'Trades extra usage for lower latency. Supported on this model.',
      currentValue: args.fastMode,
    })
  if (args.outputStyles.length > 0)
    options.push({
      type: 'select',
      id: CLAUDE_CONFIG.outputStyle,
      name: 'Output style',
      category: 'output_style',
      description: "How Claude writes back. Reads the CLI's own installed styles.",
      currentValue: args.outputStyle ?? args.outputStyles[0],
      options: args.outputStyles.map((style) => ({ value: style, name: style })),
    })
  return options
}
