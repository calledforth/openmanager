import type { SessionConfigOption } from '@agentpack/contract'

export type SessionConfigValue = string | boolean

type SelectOption = Extract<SessionConfigOption, { type: 'select' }>

/** Ids providers use for the reasoning-depth control, most specific first.
 * Measured: Claude Code `effort`; OpenCode `effort`; Cursor `effort`,
 * `reasoning` or `reasoning_effort` depending on the model. */
const EFFORT_IDS = ['effort', 'reasoning_effort', 'reasoning']

/** The option that sets how hard the model thinks, whatever the provider
 * calls it. ACP's category for it is `thought_level`, but Cursor also files a
 * `thinking` on/off switch there, so a true/false select never qualifies. */
export function effortConfigOption(
  options: readonly SessionConfigOption[] | undefined,
): SelectOption | undefined {
  const candidates = (options ?? []).filter(
    (option): option is SelectOption =>
      option.type === 'select' &&
      !isBooleanSelect(option) &&
      (option.category === 'effort' ||
        option.category === 'thought_level' ||
        EFFORT_IDS.includes(option.id.toLowerCase())),
  )
  for (const id of EFFORT_IDS) {
    const match = candidates.find((option) => option.id.toLowerCase() === id)
    if (match) return match
  }
  return candidates[0]
}

/** The option that picks the context window: Claude Code's `context_window`,
 * Cursor's `context` (e.g. 300k / 1m). */
export function contextWindowConfigOption(
  options: readonly SessionConfigOption[] | undefined,
): SelectOption | undefined {
  return (options ?? []).find(
    (option): option is SelectOption =>
      option.type === 'select' &&
      ['context', 'context_window', 'context_size'].includes(option.id.toLowerCase()),
  )
}

/** Options the composer draws as their own control, so the "Model settings"
 * menu must not draw them a second time. Effort joined model and mode when it
 * got its own pill — it is per-model and changed often enough to deserve one. */
function isSelectorOption(option: SessionConfigOption): boolean {
  const category = option.category?.toLowerCase()
  const id = option.id.toLowerCase()
  return category === 'model' || category === 'mode' || id === 'model' || id === 'mode'
}

export function configurableSessionOptions(
  options: readonly SessionConfigOption[] | undefined,
): SessionConfigOption[] {
  const effort = effortConfigOption(options)
  return (options ?? []).filter((option) => option !== effort && !isSelectorOption(option))
}

export function isBooleanSelect(option: SessionConfigOption): boolean {
  if (option.type !== 'select') return false
  const values = new Set(option.options.map((entry) => entry.value.toLowerCase()))
  return values.has('true') && values.has('false')
}

function acceptsValue(option: SessionConfigOption, value: SessionConfigValue): boolean {
  if (option.type === 'boolean') return typeof value === 'boolean'
  return typeof value === 'string' && option.options.some((entry) => entry.value === value)
}

export function updateSessionConfigOptions(
  options: readonly SessionConfigOption[] | undefined,
  configId: string,
  value: SessionConfigValue,
): SessionConfigOption[] | undefined {
  if (!options) return undefined
  let changed = false
  const next = options.map((option) => {
    if (option.id !== configId || !acceptsValue(option, value) || option.currentValue === value) {
      return option
    }
    changed = true
    return { ...option, currentValue: value } as SessionConfigOption
  })
  return changed ? next : (options as SessionConfigOption[])
}

export function applySessionConfigValues(
  options: readonly SessionConfigOption[] | undefined,
  values: Record<string, SessionConfigValue> | undefined,
): SessionConfigOption[] | undefined {
  if (!options || !values) return options as SessionConfigOption[] | undefined
  let next = options as SessionConfigOption[]
  for (const [configId, value] of Object.entries(values)) {
    next = updateSessionConfigOptions(next, configId, value) ?? next
  }
  return next
}

export function sessionConfigSummary(
  options: readonly SessionConfigOption[] | undefined,
): string[] {
  return configurableSessionOptions(options).flatMap((option) => {
    if (option.type === 'boolean') return option.currentValue ? [option.name] : []
    const selected = option.options.find((entry) => entry.value === option.currentValue)
    const normalized = option.currentValue.trim().toLowerCase()
    if (normalized === 'false' || normalized === 'off' || normalized === 'none') return []
    if (normalized === 'true') return [option.name]
    return [selected?.name ?? option.currentValue]
  })
}
