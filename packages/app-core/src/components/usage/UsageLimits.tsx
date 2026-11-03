import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import * as PopoverPrimitive from '@radix-ui/react-popover'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { ArrowRightIcon, ArrowsClockwiseIcon, GaugeIcon } from '@phosphor-icons/react'
import { isProviderId } from '@agentpack/contract'
import type { ProviderLimits, ProviderLimitWindow } from '@openmanager/protocol'
import {
  selectProviderCatalog,
  shallowEqualArray,
  type ProviderCatalogEntry,
} from '@openmanager/environment-client'
import {
  useConnectionState,
  useEnvironmentClient,
  useEnvironmentState,
} from '../../providers/environment-client'
import { useNow } from '../../lib/relative-time'
import { cn } from '../../lib/utils'
import {
  formatPercent,
  formatResetsAt,
  formatUpdated,
  headlineWindow,
  limitsStatusLine,
  ringLabel,
  usageLevel,
  type UsageLevel,
} from '../../lib/usage-limits-view'
import { ProviderIcon } from '../providers/ProviderIcon'

export type ProviderLimitsEntry = {
  providerId: string
  displayName: string
  limits: ProviderLimits
}

/** The capability an environment advertises when it can read limits again. */
const REFRESH_CAPABILITY = 'provider.limits.refresh'

const selectLimitsEntries = (state: Parameters<typeof selectProviderCatalog>[0]) =>
  selectProviderCatalog(state).filter(
    (entry: ProviderCatalogEntry) => entry.limits?.supported === true,
  )

/**
 * Providers that can report usage limits, as the environment last knew them,
 * and a way to ask for a fresh read. Asking is cheap: the environment keeps a
 * reading for at least a minute and runs one read per provider at a time.
 */
export function useProviderLimits(): {
  entries: ProviderLimitsEntry[]
  canRefresh: boolean
  refresh: (providerId: string, maxAgeMs?: number) => void
} {
  const client = useEnvironmentClient()
  const catalog = useEnvironmentState(selectLimitsEntries, shallowEqualArray)
  const canRefresh = useConnectionState().capabilities.includes(REFRESH_CAPABILITY)
  const entries = useMemo(
    () =>
      catalog.map((entry) => ({
        providerId: entry.id,
        displayName: entry.displayName,
        limits: entry.limits,
      })),
    [catalog],
  )
  const refresh = useCallback(
    (providerId: string, maxAgeMs?: number) => {
      if (!canRefresh) return
      // The answer is a current state the event also brings; a failure only
      // means the old reading stays, which the card already says.
      void client.commands
        .refreshProviderLimits({ providerId, ...(maxAgeMs !== undefined ? { maxAgeMs } : {}) })
        .catch(() => undefined)
    },
    [client, canRefresh],
  )
  return { entries, canRefresh, refresh }
}

/** Ask for fresh limits now and every `intervalMs` while the page is visible.
 * `maxAgeMs` lets a reading that is young enough stand. */
export function useLimitsRefresh(
  entries: readonly ProviderLimitsEntry[],
  refresh: (providerId: string, maxAgeMs?: number) => void,
  { maxAgeMs, intervalMs }: { maxAgeMs: number; intervalMs?: number },
): void {
  const ids = entries.map((entry) => entry.providerId).join('\n')
  useEffect(() => {
    if (!ids) return
    const ask = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      for (const providerId of ids.split('\n')) refresh(providerId, maxAgeMs)
    }
    ask()
    if (!intervalMs) return
    const timer = setInterval(ask, intervalMs)
    const onVisible = () => {
      if (document.visibilityState === 'visible') ask()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [ids, refresh, maxAgeMs, intervalMs])
}

const LEVEL_STROKE: Record<UsageLevel, string> = {
  unknown: 'text-muted-foreground',
  normal: 'text-foreground/85',
  warning: 'text-(--basis-status-needs)',
  critical: 'text-(--basis-status-error)',
}

const LEVEL_FILL: Record<UsageLevel, string> = {
  unknown: 'bg-muted-foreground/50',
  normal: 'bg-foreground/80',
  warning: 'bg-(--basis-status-needs)',
  critical: 'bg-(--basis-status-error)',
}

const LEVEL_WORD: Partial<Record<UsageLevel, string>> = {
  warning: 'Running low',
  critical: 'Almost out',
}

/** A ring that fills with one window's usage. The track stays visible at any
 * percent so a low reading never looks like a loading spinner. */
export function UsageRing({
  window,
  size = 16,
  className,
}: {
  window: ProviderLimitWindow | null
  size?: number
  className?: string
}) {
  const level = usageLevel(window)
  const radius = 6.25
  const circumference = 2 * Math.PI * radius
  const used = window?.status === 'limited' ? 100 : (window?.usedPercent ?? 0)
  const length = Math.max(0, Math.min(100, used)) / 100
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      aria-hidden
      className={cn('shrink-0', LEVEL_STROKE[level], className)}
    >
      <circle
        cx="8"
        cy="8"
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        className="opacity-25"
      />
      {window && length > 0 ? (
        <circle
          cx="8"
          cy="8"
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={`${length * circumference} ${circumference}`}
          transform="rotate(-90 8 8)"
          className="transition-[stroke-dasharray] duration-300 ease-out motion-reduce:transition-none"
        />
      ) : null}
    </svg>
  )
}

/** One window: label, percent, a thin bar, and when it resets. */
export function UsageMeter({
  window,
  now,
  size = 'compact',
}: {
  window: ProviderLimitWindow
  now: number
  size?: 'compact' | 'comfortable'
}) {
  const level = usageLevel(window)
  const word = LEVEL_WORD[level]
  const used = window.status === 'limited' ? 100 : window.usedPercent
  const reset = formatResetsAt(window.resetsAt, now)
  const comfortable = size === 'comfortable'
  return (
    <div className={comfortable ? 'py-1' : undefined}>
      <div className={cn('flex items-baseline gap-2', comfortable ? 'text-[13px]' : 'text-[12px]')}>
        <span className="min-w-0 truncate text-foreground">{window.label}</span>
        {word ? (
          <span
            className={cn(
              'shrink-0 text-[11px] font-medium',
              level === 'critical' ? 'text-(--basis-status-error)' : 'text-(--basis-status-needs)',
            )}
          >
            {window.status === 'limited' ? 'Limit reached' : word}
          </span>
        ) : null}
        <span className="ml-auto shrink-0 tabular-nums text-foreground">
          {window.status === 'limited' ? '100%' : formatPercent(window.usedPercent)}
        </span>
      </div>
      <div
        role="meter"
        aria-label={window.label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={used ?? undefined}
        aria-valuetext={used === null ? 'Unknown' : `${Math.round(used)}% used`}
        className={cn(
          'mt-1.5 overflow-hidden rounded-full bg-foreground/10',
          comfortable ? 'h-1.5' : 'h-1',
        )}
      >
        <div
          className={cn(
            'h-full rounded-full transition-[width] duration-300 ease-out motion-reduce:transition-none',
            LEVEL_FILL[level],
          )}
          style={{ width: `${used ?? 0}%` }}
        />
      </div>
      {reset ? (
        <div className={cn('mt-1 text-faint', comfortable ? 'text-[12px]' : 'text-[11px]')}>
          {reset}
        </div>
      ) : null}
    </div>
  )
}

/** Refresh, spinning while a read runs. */
function RefreshButton({
  refreshing,
  onRefresh,
  label,
}: {
  refreshing: boolean
  onRefresh?: () => void
  label: string
}) {
  if (!onRefresh) return null
  return (
    <button
      type="button"
      aria-label={refreshing ? 'Reading usage' : label}
      title={refreshing ? 'Reading usage…' : label}
      disabled={refreshing}
      onClick={onRefresh}
      className={cn(
        'grid size-6 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground transition-colors duration-100',
        'hover:bg-hover hover:text-foreground disabled:cursor-default disabled:hover:bg-transparent',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus-ring',
      )}
    >
      <ArrowsClockwiseIcon
        className={cn('size-3.5', refreshing && 'animate-spin motion-reduce:animate-none')}
      />
    </button>
  )
}

/** A provider's limits: header with age and refresh, then one meter per window. */
export function ProviderLimitsCard({
  entry,
  now,
  onRefresh,
  size = 'compact',
  footer,
}: {
  entry: ProviderLimitsEntry
  now: number
  onRefresh?: () => void
  size?: 'compact' | 'comfortable'
  footer?: ReactNode
}) {
  const { limits } = entry
  const windows = limits.reading?.windows ?? []
  const status = limitsStatusLine(limits)
  const updated = formatUpdated(limits.reading?.at, now)
  const comfortable = size === 'comfortable'
  const extra = limits.reading?.extraUsage
  return (
    <div>
      <div className="flex items-center gap-2">
        {isProviderId(entry.providerId) ? (
          <ProviderIcon
            providerId={entry.providerId}
            className={comfortable ? 'h-4 w-4' : 'h-3.5 w-3.5'}
          />
        ) : null}
        <span
          className={cn('text-foreground', comfortable ? 'text-[14px] font-medium' : 'text-[12px]')}
        >
          {entry.displayName}
        </span>
        <span className="ml-auto truncate text-[11px] text-faint">
          {limits.refreshing && limits.reading ? 'Refreshing…' : updated}
        </span>
        <RefreshButton
          refreshing={limits.refreshing}
          onRefresh={onRefresh}
          label={`Refresh ${entry.displayName} usage`}
        />
      </div>
      {status ? (
        <p
          className={cn(
            'text-muted-foreground',
            comfortable ? 'mt-3 text-[13px]' : 'mt-2 text-[12px]',
          )}
        >
          {status}
        </p>
      ) : null}
      {windows.length > 0 ? (
        <div className={cn('flex flex-col', comfortable ? 'mt-4 gap-4' : 'mt-3 gap-3')}>
          {windows.map((window) => (
            <UsageMeter key={window.id} window={window} now={now} size={size} />
          ))}
        </div>
      ) : null}
      {extra ? (
        <div
          className={cn(
            'flex items-baseline gap-2 text-muted-foreground',
            comfortable ? 'mt-4 text-[13px]' : 'mt-3 text-[12px]',
          )}
        >
          <span>Extra usage</span>
          <span className="ml-auto tabular-nums">
            {extra.enabled
              ? extra.usedPercent !== null
                ? `${formatPercent(extra.usedPercent)} of monthly limit`
                : 'On'
              : 'Off'}
          </span>
        </div>
      ) : null}
      {footer}
    </div>
  )
}

const OPEN_DELAY_MS = 250
const CLOSE_DELAY_MS = 160

/**
 * The sidebar's Usage control: a ring for the headline window. Hovering (or
 * focusing) shows every window in a small card; clicking opens the Usage page.
 */
export function UsageDockButton({
  onOpenPage,
  active = false,
  className,
}: {
  onOpenPage: () => void
  active?: boolean
  className?: string
}) {
  const { entries, canRefresh, refresh } = useProviderLimits()
  // A reading that is ten minutes old is fine for a glance; the Usage page
  // asks for fresher numbers itself.
  useLimitsRefresh(entries, refresh, { maxAgeMs: 10 * 60_000, intervalMs: 10 * 60_000 })
  const now = useNow(30_000)
  const primary = entries[0]
  const window = headlineWindow(primary?.limits)
  const [open, setOpen] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const reduceMotion = useReducedMotion()

  const schedule = (next: boolean, delay: number) => {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setOpen(next), delay)
  }
  useEffect(() => () => clearTimeout(timer.current), [])
  useEffect(() => {
    // Opening the card is a good moment to catch up if the reading is old.
    if (open && primary) refresh(primary.providerId, 2 * 60_000)
  }, [open, primary, refresh])

  const label = primary ? ringLabel(window, now) : 'Usage'
  return (
    <PopoverPrimitive.Root open={open && entries.length > 0} onOpenChange={setOpen} modal={false}>
      <PopoverPrimitive.Anchor asChild>
        <button
          type="button"
          aria-label={label}
          aria-current={active ? 'page' : undefined}
          onClick={() => {
            clearTimeout(timer.current)
            setOpen(false)
            onOpenPage()
          }}
          onPointerEnter={(event) => {
            if (event.pointerType === 'mouse') schedule(true, OPEN_DELAY_MS)
          }}
          onPointerLeave={(event) => {
            if (event.pointerType === 'mouse') schedule(false, CLOSE_DELAY_MS)
          }}
          onFocus={(event) => {
            if (event.currentTarget.matches(':focus-visible')) schedule(true, 0)
          }}
          onBlur={() => schedule(false, CLOSE_DELAY_MS)}
          className={className}
        >
          {primary ? <UsageRing window={window} /> : <GaugeIcon className="size-4" />}
        </button>
      </PopoverPrimitive.Anchor>
      <AnimatePresence>
        {open && primary ? (
          <PopoverPrimitive.Portal forceMount>
            <PopoverPrimitive.Content
              forceMount
              asChild
              side="top"
              align="start"
              sideOffset={8}
              collisionPadding={8}
              onOpenAutoFocus={(event) => event.preventDefault()}
              onCloseAutoFocus={(event) => event.preventDefault()}
              onPointerEnter={() => clearTimeout(timer.current)}
              onPointerLeave={() => schedule(false, CLOSE_DELAY_MS)}
            >
              <motion.div
                initial={reduceMotion ? false : { opacity: 0, scale: 0.96, y: 4 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.98, y: 2 }}
                transition={{ duration: reduceMotion ? 0 : 0.16, ease: [0.22, 1, 0.36, 1] }}
                style={{ transformOrigin: 'var(--radix-popover-content-transform-origin)' }}
                className="z-50 w-[272px] rounded-float bg-float p-3 pb-1.5 text-left shadow-float"
              >
                <div className="flex flex-col gap-4">
                  {entries.map((entry) => (
                    <ProviderLimitsCard
                      key={entry.providerId}
                      entry={entry}
                      now={now}
                      onRefresh={canRefresh ? () => refresh(entry.providerId, 0) : undefined}
                    />
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false)
                    onOpenPage()
                  }}
                  className={cn(
                    'mt-2.5 -mx-1.5 flex w-[calc(100%+12px)] cursor-pointer items-center justify-between rounded-lg px-2 py-1.5',
                    'text-muted-foreground transition-colors duration-100 hover:bg-hover hover:text-foreground',
                    'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus-ring',
                  )}
                >
                  {/* On the span: the global `button { font: inherit }` sits
                      outside Tailwind's layers and beats a size utility here. */}
                  <span className="text-[12px]">Open usage</span>
                  <ArrowRightIcon className="size-3.5" />
                </button>
              </motion.div>
            </PopoverPrimitive.Content>
          </PopoverPrimitive.Portal>
        ) : null}
      </AnimatePresence>
    </PopoverPrimitive.Root>
  )
}
