import type { ComponentType } from 'react'
import {
  CheckCircleIcon,
  CheckIcon,
  CircleDashedIcon,
  CircleIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  MinusCircleIcon,
  SkipForwardIcon,
  XCircleIcon,
  XIcon,
  type IconProps,
} from '@phosphor-icons/react'
import type {
  PullRequestCheckRun,
  PullRequestChecks,
  PullRequestReviewDecision,
  PullRequestReviewer,
  PullRequestState,
  PullRequestSummary,
} from '@openmanager/protocol'

/** The key a panel selects by: one pull request, whichever session links it. */
export function pullRequestKey(pr: Pick<PullRequestSummary, 'repository' | 'number'>): string {
  return `${pr.repository}#${pr.number}`
}

type Glyph = ComponentType<IconProps>

export interface StateMeta {
  label: string
  /** The ink. Every state maps to one of the app's status tokens. */
  color: string
  /** The ink made translucent: the chip's fill. */
  wash: string
  Icon: Glyph
}

/**
 * State → colour, as the user approved: open is green, draft is grey, merged
 * is violet (GitHub's purple, in our palette), closed is red. Draft keeps the
 * open glyph in a dashed ring, so a draft reads as "an open one, not ready".
 */
export const PR_STATE: Record<PullRequestState, StateMeta> = {
  open: {
    label: 'Open',
    color: 'var(--basis-status-done)',
    wash: 'var(--basis-status-done-wash)',
    Icon: GitPullRequestIcon,
  },
  draft: {
    label: 'Draft',
    color: 'var(--basis-text-muted)',
    wash: 'var(--hover)',
    Icon: GitPullRequestDraftIcon,
  },
  merged: {
    label: 'Merged',
    color: 'var(--basis-status-working)',
    wash: 'color-mix(in srgb, var(--basis-status-working) 14%, transparent)',
    Icon: GitMergeIcon,
  },
  closed: {
    label: 'Closed',
    color: 'var(--basis-status-error)',
    wash: 'var(--basis-status-error-wash)',
    Icon: GitPullRequestClosedIcon,
  },
}

/** A pull request the environment has not read yet has no state. */
export const PR_STATE_UNKNOWN: StateMeta = {
  label: 'Not read yet',
  color: 'var(--basis-text-faint)',
  wash: 'var(--hover)',
  Icon: CircleDashedIcon,
}

export function stateMeta(state: PullRequestState | null): StateMeta {
  return state ? PR_STATE[state] : PR_STATE_UNKNOWN
}

/** Open pull request, dashed: Phosphor has no draft glyph, so this mirrors its 16-grid. */
function GitPullRequestDraftIcon({ size = 16, className, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 256 256"
      fill="none"
      stroke="currentColor"
      strokeWidth={24}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden={rest['aria-hidden'] ?? true}
    >
      <circle cx={68} cy={64} r={32} />
      <circle cx={68} cy={192} r={32} />
      <circle cx={188} cy={192} r={32} />
      <path d="M68 96v64" />
      <circle cx={188} cy={64} r={32} strokeDasharray="18 20" />
      <path d="M188 112v16" strokeDasharray="18 20" />
    </svg>
  )
}

/** Open pull request with a cross where the merge would be. */
function GitPullRequestClosedIcon({ size = 16, className, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 256 256"
      fill="none"
      stroke="currentColor"
      strokeWidth={24}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden={rest['aria-hidden'] ?? true}
    >
      <circle cx={68} cy={64} r={32} />
      <circle cx={68} cy={192} r={32} />
      <circle cx={188} cy={192} r={32} />
      <path d="M68 96v64" />
      <path d="M160 36l56 56M216 36l-56 56" />
      <path d="M188 120v40" />
    </svg>
  )
}

export interface ChecksMeta {
  label: string
  color: string
  Icon: Glyph
}

export const PR_CHECKS: Record<PullRequestChecks, ChecksMeta> = {
  passing: { label: 'Passing', color: 'var(--basis-status-done)', Icon: CheckCircleIcon },
  failing: { label: 'Failing', color: 'var(--basis-status-error)', Icon: XCircleIcon },
  pending: { label: 'Running', color: 'var(--basis-status-needs)', Icon: CircleDashedIcon },
}

export const CHECK_RUN: Record<PullRequestCheckRun['state'], ChecksMeta> = {
  success: { label: 'Passed', color: 'var(--basis-status-done)', Icon: CheckIcon },
  failure: { label: 'Failed', color: 'var(--basis-status-error)', Icon: XIcon },
  pending: { label: 'Running', color: 'var(--basis-status-needs)', Icon: CircleIcon },
  neutral: { label: 'Neutral', color: 'var(--basis-text-faint)', Icon: MinusCircleIcon },
  skipped: { label: 'Skipped', color: 'var(--basis-text-faint)', Icon: SkipForwardIcon },
}

export const REVIEW_DECISION: Record<PullRequestReviewDecision, ChecksMeta> = {
  approved: { label: 'Approved', color: 'var(--basis-status-done)', Icon: CheckCircleIcon },
  changes_requested: {
    label: 'Changes requested',
    color: 'var(--basis-status-error)',
    Icon: XCircleIcon,
  },
  review_required: {
    label: 'Review required',
    color: 'var(--basis-text-muted)',
    Icon: CircleDashedIcon,
  },
}

export const REVIEWER_STATE: Record<PullRequestReviewer['state'], ChecksMeta> = {
  approved: { label: 'approved', color: 'var(--basis-status-done)', Icon: CheckIcon },
  changes_requested: {
    label: 'requested changes',
    color: 'var(--basis-status-error)',
    Icon: XIcon,
  },
  commented: { label: 'commented', color: 'var(--basis-text-muted)', Icon: MinusCircleIcon },
  requested: { label: 'awaiting review', color: 'var(--basis-text-faint)', Icon: CircleIcon },
}

// ─── Label colours ──────────────────────────────────────────────────────────

function parseHex(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex)
  if (!m) return null
  const n = parseInt(m[1]!, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function toHex([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b].map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`
}

function luminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

function mix(a: [number, number, number], b: [number, number, number], t: number) {
  return a.map((c, i) => c + (b[i]! - c) * t) as [number, number, number]
}

const WHITE: [number, number, number] = [255, 255, 255]
const BLACK: [number, number, number] = [0, 0, 0]

/**
 * GitHub label colours as ink for each scheme. GitHub picks any hex; on our
 * dark canvas a navy or maroon vanishes, on a light one a yellow does. Dark
 * ink is lifted toward white, light ink is pulled toward black, by as much as
 * its luminance is off, so a mid-tone keeps GitHub's own colour. The
 * inverse of GitHub's own rule: the ink here is the dot and the tint, and the
 * name stays in the theme's text, so a label never has to fight its fill.
 */
export function labelInk(color: string): { dark: string; light: string } {
  const rgb = parseHex(color) ?? [163, 163, 163]
  const lum = luminance(rgb)
  // Target: on dark, ink at least ~0.3 luminance; on light, at most ~0.3.
  const dark = lum < 0.3 ? mix(rgb, WHITE, Math.min(0.6, (0.3 - lum) * 2.2)) : rgb
  const light = lum > 0.3 ? mix(rgb, BLACK, Math.min(0.55, (lum - 0.3) * 0.9)) : rgb
  return { dark: toHex(dark), light: toHex(light) }
}

/** Inline style carrying the label's ink, resolved by the theme's colour-scheme. */
export function labelStyle(color: string): React.CSSProperties {
  const ink = labelInk(color)
  return { '--pr-label': `light-dark(${ink.dark}, ${ink.light})` } as React.CSSProperties
}

/** "2h ago" / "yesterday" / "Mar 3": for the times a PR view shows beside a verb. */
export function ago(iso: string | null | undefined, now: number): string {
  const at = iso ? Date.parse(iso) : Number.NaN
  if (Number.isNaN(at)) return ''
  const age = Math.max(0, now - at)
  const MIN = 60_000
  const HOUR = 60 * MIN
  const DAY = 24 * HOUR
  if (age < MIN) return 'just now'
  if (age < HOUR) return `${Math.floor(age / MIN)}m ago`
  if (age < DAY) return `${Math.floor(age / HOUR)}h ago`
  if (age < 2 * DAY) return 'yesterday'
  if (age < 7 * DAY) return `${Math.floor(age / DAY)}d ago`
  const date = new Date(at)
  const sameYear = date.getFullYear() === new Date(now).getFullYear()
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  })
}

/** Thousands with a thin separator, so "+1,204" stays scannable. */
export function count(n: number): string {
  return n.toLocaleString('en-US')
}
