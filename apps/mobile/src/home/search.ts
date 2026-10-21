/**
 * Search is by words: every term the reader typed must appear somewhere in
 * the title or the project, in any order, so "tool pay" finds "Tool Call
 * Payloads". Case does not matter.
 */
export function searchTerms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean)
}

export function matchesTerms(
  terms: readonly string[],
  ...haystacks: (string | undefined)[]
): boolean {
  if (terms.length === 0) return false
  const text = haystacks
    .filter((h): h is string => typeof h === 'string')
    .join(' ')
    .toLowerCase()
  return terms.every((term) => text.includes(term))
}
