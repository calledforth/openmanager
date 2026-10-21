/** Every `data-theme` scheme the generator resolves. */
export const SCHEMES: readonly string[]

/** Resolved tokens per scheme: scheme id → (property name without `--` → value). */
export function generateThemeTokens(): Map<string, Map<string, string>>

/** The generated TypeScript file's text. */
export function renderThemeTokens(): string

/** The checked-in generated file's text, or '' when it does not exist. */
export function currentThemeTokensFile(): string
