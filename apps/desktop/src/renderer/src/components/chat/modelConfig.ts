import type { SessionConfigOption } from '@agentpack/contract'

export type SessionConfigValue = string | boolean

function isPrimaryComposerOption(option: SessionConfigOption): boolean {
  const category = option.category?.toLowerCase()
  const id = option.id.toLowerCase()
  return category === 'model' || category === 'mode' || id === 'model' || id === 'mode'
}

export function configurableSessionOptions(
  options: readonly SessionConfigOption[] | undefined,
): SessionConfigOption[] {
  return (options ?? []).filter((option) => !isPrimaryComposerOption(option))
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
