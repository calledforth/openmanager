/** Splitting a Claude Code model row into the name people say and the rest.
 *
 * The CLI puts the bare family in `displayName` and the *versioned* name in
 * the first `·`-segment of `description`:
 *
 *   {displayName: 'Opus', description: 'Opus 5 · Best for everyday, complex
 *    tasks · ~2× usage vs Sonnet'}
 *
 * That is not a bug to route around — the CLI's own picker renders the name as
 * the row and the description as its subtitle, so the version lives in the
 * subtitle by design. We show one line, so we have to lift it.
 *
 * The guard is the whole reason this is a function rather than a `split`. The
 * `default` row's first segment names what it *resolves to*, not itself:
 *
 *   {displayName: 'Default (recommended)', description: 'Sonnet 5 · Efficient…'}
 *
 * Splitting blindly relabels that row "Sonnet 5", which is both wrong and
 * unstable — it changes whenever Anthropic repoints the alias. So a segment is
 * promoted only when it extends the name already there. */
const SEPARATOR = '·'

function segments(description: string | undefined): string[] {
  return (description ?? '')
    .split(SEPARATOR)
    .map((segment) => segment.trim())
    .filter(Boolean)
}

/** The name to show: "Opus 5" where the CLI offers it, "Opus" where it does
 * not, and never a name belonging to a different model. */
export function modelLabel(displayName: string, description?: string): string {
  const [first] = segments(description)
  if (!first || first === displayName) return displayName
  // `startsWith` rather than `includes`: "Sonnet 5" must not be allowed to
  // rename "Default (recommended)", and only a suffix (the version) may be
  // added to a name we already have.
  return first.toLowerCase().startsWith(displayName.toLowerCase()) ? first : displayName
}

/** What belongs in the tooltip: the description minus the versioned name, once
 * that name has been promoted into the label. Returns the whole description
 * when nothing was promoted, so the `default` row still explains itself. */
export function modelHint(displayName: string, description?: string): string | undefined {
  const parts = segments(description)
  if (parts.length === 0) return undefined
  const promoted = modelLabel(displayName, description) !== displayName
  const rest = promoted ? parts.slice(1) : parts
  return rest.length > 0 ? rest.join(` ${SEPARATOR} `) : undefined
}
