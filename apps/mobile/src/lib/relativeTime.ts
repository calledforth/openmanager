// Dependency-free relative-time formatter for session timestamps ("2m ago").
// Desktop has no shared equivalent to mirror, so this is the canonical mobile
// implementation. Pure and testable: `now` is injectable.

export function formatRelativeTime(timestamp: number, now: number = Date.now()): string {
  const diffMs = now - timestamp

  if (!Number.isFinite(diffMs) || diffMs < 45_000) {
    return 'just now'
  }

  const minutes = Math.floor(diffMs / 60_000)
  if (minutes < 60) return `${minutes}m ago`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`

  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`

  const weeks = Math.floor(days / 7)
  if (weeks < 5) return `${weeks}w ago`

  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo ago`

  const years = Math.floor(days / 365)
  return `${years}y ago`
}
