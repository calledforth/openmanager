import type { SessionConfigOption, SessionConfigSelectValue } from '@agentpack/contract'

const str = (value: unknown): string => (typeof value === 'string' ? value : '')

/** A select's values, with ACP's grouped form (`{group, name, options}`)
 * flattened: the composer draws one list, and the group headings carry no
 * value of their own. */
function selectValues(raw: unknown): SessionConfigSelectValue[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((entry): SessionConfigSelectValue[] => {
    const value = (entry ?? {}) as Record<string, unknown>
    if (Array.isArray(value.options)) return selectValues(value.options)
    const id = str(value.value)
    if (!id) return []
    const description = str(value.description)
    return [{ value: id, name: str(value.name) || id, ...(description ? { description } : {}) }]
  })
}

/** Whether an option is the model or mode selector itself, which the composer
 * draws from the catalog rather than as a setting. */
function isSelector(option: { id: string; category?: string }): boolean {
  return (
    option.id === 'model' ||
    option.id === 'mode' ||
    option.category === 'model' ||
    option.category === 'mode'
  )
}

/** A model's settings as a catalog listed them, narrowed to the two shapes a
 * session can carry. A malformed entry costs only itself, and the model and
 * mode selectors are dropped: a model row cannot list the models. */
export function catalogConfigOptions(raw: unknown): SessionConfigOption[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  return raw.flatMap((entry): SessionConfigOption[] => {
    const option = (entry ?? {}) as Record<string, unknown>
    const id = str(option.id).trim()
    if (!id || seen.has(id)) return []
    const category = str(option.category) || undefined
    if (isSelector({ id, category })) return []
    const common = {
      id,
      name: str(option.name) || id,
      ...(str(option.description) ? { description: str(option.description) } : {}),
      ...(category ? { category } : {}),
    }
    if (option.type === 'boolean') {
      if (typeof option.currentValue !== 'boolean') return []
      seen.add(id)
      return [{ type: 'boolean', ...common, currentValue: option.currentValue }]
    }
    if (option.type !== 'select') return []
    const options = selectValues(option.options)
    if (options.length === 0) return []
    const current = str(option.currentValue)
    seen.add(id)
    return [
      {
        type: 'select',
        ...common,
        currentValue: options.some((value) => value.value === current)
          ? current
          : options[0].value,
        options,
      },
    ]
  })
}
