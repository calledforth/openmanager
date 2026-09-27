import { z } from 'zod'

/**
 * Where a session's title came from, weakest first: the first prompt cut to
 * size, the agent's own name for its session, a name the environment's title
 * model wrote, and a rename by the user.
 */
export const SESSION_TITLE_SOURCES = ['fallback', 'provider', 'generated', 'user'] as const

export const SessionTitleSourceSchema = z.enum(SESSION_TITLE_SOURCES)
export type SessionTitleSource = z.infer<typeof SessionTitleSourceSchema>

/**
 * The tools that can write session titles. Each is a CLI the environment runs
 * once per title, apart from any session; `off` leaves naming to the first
 * prompt and the agent.
 */
export const TITLE_GENERATION_PROVIDERS = ['off', 'codex', 'claude', 'cursor', 'opencode'] as const
export const TitleGenerationProviderSchema = z.enum(TITLE_GENERATION_PROVIDERS)
export type TitleGenerationProvider = z.infer<typeof TitleGenerationProviderSchema>

/**
 * The model each tool titles with when the setting names none: small and
 * fast, since a title is a few words. OpenCode has no model every install
 * shares, so an empty id means its own configured default.
 */
export const DEFAULT_TITLE_GENERATION_MODELS: Readonly<
  Record<Exclude<TitleGenerationProvider, 'off'>, string>
> = Object.freeze({
  codex: 'gpt-6-luna',
  claude: 'haiku',
  cursor: 'composer-2.5',
  opencode: '',
})

export const TitleGenerationSettingSchema = z.object({
  provider: TitleGenerationProviderSchema,
  /** Empty means the provider's default from `DEFAULT_TITLE_GENERATION_MODELS`. */
  model: z.string().trim().max(256),
})
export type TitleGenerationSetting = z.infer<typeof TitleGenerationSettingSchema>

export function isPlaceholderTitle(title: string | null | undefined): boolean {
  if (!title) return true
  const trimmed = title.trim()
  if (!trimmed) return true
  if (/^ACP Session\s+[0-9a-f-]{8,}$/i.test(trimmed)) return true
  if (/^New session\s*-\s*\d+$/i.test(trimmed)) return true
  if (/^session[-_\s]?[0-9a-z]{6,}$/i.test(trimmed)) return true
  return false
}

export function shouldReplaceSessionTitle(
  existingTitle: string | null | undefined,
  existingSource: SessionTitleSource | undefined,
  incomingSource: SessionTitleSource,
): boolean {
  if (incomingSource === 'user') return true
  if (incomingSource === 'generated') return existingSource !== 'user'
  // A generated title was written on purpose to replace the agent's name for
  // the session; the agent renaming its session later must not undo it.
  if (incomingSource === 'provider')
    return existingSource !== 'user' && existingSource !== 'generated'
  // A written title can look like a placeholder ("Session Timeout"); it
  // still is not one.
  return existingSource !== 'generated' && isPlaceholderTitle(existingTitle)
}

export const SESSION_TITLE_MAX_LENGTH = 80
/** Room for the ellipsis that replaces what was cut. */
const SESSION_TITLE_CUT_LENGTH = SESSION_TITLE_MAX_LENGTH - 3

/**
 * Name a session after the prompt that started it: one line, short enough for
 * a sidebar row. Measured in code points rather than UTF-16 units, so a cut
 * cannot land inside an astral character and leave an unpaired surrogate.
 */
export function titleFromPrompt(text: string): string | undefined {
  const singleLine = text.replace(/\s+/g, ' ').trim()
  if (!singleLine) return undefined
  const characters = Array.from(singleLine)
  return characters.length > SESSION_TITLE_MAX_LENGTH
    ? `${characters.slice(0, SESSION_TITLE_CUT_LENGTH).join('')}...`
    : singleLine
}
