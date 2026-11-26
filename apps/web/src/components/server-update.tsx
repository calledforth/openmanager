import { useEffect, useState } from 'react'
import {
  ArrowCircleUpIcon,
  ArrowClockwiseIcon,
  CheckCircleIcon,
  WarningCircleIcon,
  XIcon,
} from '@phosphor-icons/react'
import { Button } from '@openmanager/app-core/components/fluid/ui/button'
import { nameWithoutPlatform } from '@openmanager/app-core/components/ui/EnvironmentPlatformIcon'
import type { StoredEnvironment } from '@openmanager/environment-client/connection'
import { cn } from '../lib/utils'
import { useConnection } from '../providers/connection-provider'
import { useServerUpdate, type ServerUpdateHandle } from '../providers/server-updates'
import { IconAction } from './connection-surfaces'

/**
 * The environment server's own updates, in three places: a toast over every
 * page when a saved environment has a new release (and while it updates), a
 * line under each environment in Settings → Environments, and an Update
 * button on the screen shown when a server is too old for this app.
 */

const DISMISSED_KEY = 'openmanager.serverUpdate.dismissed'
/** How long the "updated" toast stays before it leaves by itself. */
export const UPDATED_TOAST_MS = 8_000

function readDismissed(): Record<string, string> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? '{}')
    return value && typeof value === 'object' ? (value as Record<string, string>) : {}
  } catch {
    return {}
  }
}

function writeDismissed(environmentId: string, version: string) {
  try {
    localStorage.setItem(
      DISMISSED_KEY,
      JSON.stringify({ ...readDismissed(), [environmentId]: version }),
    )
  } catch {
    // Without storage the toast comes back next time; that is all.
  }
}

function Spinner() {
  return <span className="todo-progress-loader shrink-0" aria-hidden="true" />
}

/** Floating toasts for every saved environment that has something to say about its server. */
export function ServerUpdateToasts({ className }: { className?: string }) {
  const { environments } = useConnection()
  return (
    <>
      {environments.map((environment) => (
        <ServerUpdateToast
          key={environment.environmentId}
          environment={environment}
          className={className}
        />
      ))}
    </>
  )
}

function ServerUpdateToast({
  environment,
  className,
}: {
  environment: StoredEnvironment
  className?: string
}) {
  const handle = useServerUpdate(environment.environmentId)
  const { notice } = handle
  const [dismissed, setDismissed] = useState(() => readDismissed()[environment.environmentId])
  const name = nameWithoutPlatform(environment.label, environment.platform)

  // "Updated" is news once, then it goes.
  const { acknowledge } = handle
  useEffect(() => {
    if (notice.kind !== 'updated') return
    const timer = setTimeout(acknowledge, UPDATED_TOAST_MS)
    return () => clearTimeout(timer)
  }, [notice.kind, acknowledge])

  if (notice.kind === 'none') return null
  if (notice.kind === 'available' && dismissed === notice.to) return null

  const shell = (tone: 'status' | 'alert', body: React.ReactNode) => (
    <div
      role={tone}
      className={cn(
        'chat-animate-slide-up flex w-fit max-w-[640px] items-center gap-2 rounded-[14px] bg-float py-1 pl-3 pr-1 shadow-float',
        className,
      )}
    >
      {body}
    </div>
  )

  switch (notice.kind) {
    case 'available':
      return shell(
        'status',
        <>
          <ArrowCircleUpIcon
            aria-hidden
            weight="fill"
            className="size-4 shrink-0 text-[var(--basis-session-cube-ready)]"
          />
          <p className="min-w-0 text-[13px] leading-5 text-foreground">
            <span className="font-medium">Server update</span>
            <span className="text-muted-foreground">
              {' · '}
              {name} {notice.from} → {notice.to}
            </span>
          </p>
          {notice.canUpdate ? (
            <Button
              type="button"
              variant="secondary"
              size="compact"
              className="shrink-0"
              disabled={handle.snapshot.starting}
              onClick={() => void handle.update(notice.to)}
            >
              Update
            </Button>
          ) : (
            <span className="shrink-0 text-[12px] text-faint" title={notice.reason}>
              Run “openmanager update”
            </span>
          )}
          <IconAction
            label="Not now"
            icon={XIcon}
            className="shrink-0"
            onClick={() => {
              writeDismissed(environment.environmentId, notice.to)
              setDismissed(notice.to)
            }}
          />
        </>,
      )
    case 'updating':
      return shell(
        'status',
        <p className="flex min-w-0 items-center gap-2 py-1 pr-2 text-[13px] leading-5 text-foreground">
          <Spinner />
          <span>
            Updating {name}
            {notice.to ? ` to ${notice.to}` : ''}…
            <span className="text-muted-foreground"> the server restarts by itself</span>
          </span>
        </p>,
      )
    case 'updated':
      return shell(
        'status',
        <>
          <CheckCircleIcon
            aria-hidden
            weight="fill"
            className="size-4 shrink-0 text-[var(--basis-session-cube-ready)]"
          />
          <p className="min-w-0 text-[13px] leading-5 text-foreground">
            {name} is on <span className="font-medium">{notice.to}</span>
            <span className="text-muted-foreground"> · updated from {notice.from}</span>
          </p>
          <IconAction
            label="Dismiss"
            icon={XIcon}
            className="shrink-0"
            onClick={handle.acknowledge}
          />
        </>,
      )
    case 'restart_required':
      return shell(
        'status',
        <p className="min-w-0 py-1 pr-2 text-[13px] leading-5 text-foreground">
          {notice.to ?? 'The update'} is installed on {name}.
          <span className="text-muted-foreground">
            {' '}
            Restart its server to finish (it was started by hand).
          </span>
        </p>,
      )
    case 'failed':
      return shell(
        'alert',
        <>
          <WarningCircleIcon
            aria-hidden
            weight="fill"
            className="size-4 shrink-0 text-[var(--basis-session-cube-needs)]"
          />
          <p className="min-w-0 text-[13px] leading-5 text-foreground">
            Updating {name} failed
            <span className="text-muted-foreground"> · {firstLine(notice.error)}</span>
          </p>
          <Button
            type="button"
            variant="ghost"
            size="compact"
            className="shrink-0 text-foreground"
            onClick={() => void handle.update(notice.to)}
          >
            Try again
          </Button>
        </>,
      )
  }
}

function firstLine(text: string): string {
  const line = text.split('\n').find((part) => part.trim() !== '') ?? text
  return line.length > 140 ? `${line.slice(0, 139)}…` : line
}

/**
 * The server's version under an environment in Settings → Environments, with
 * what can be done about it: update, follow one, or check again.
 */
export function ServerVersionLine({ environmentId }: { environmentId: string }) {
  const handle = useServerUpdate(environmentId)
  const { snapshot, notice } = handle
  const status = snapshot.status
  if (snapshot.unsupported) {
    return (
      <VersionLine>
        <span className="text-muted-foreground">
          Server too old to update from here · run “openmanager update” on its machine
        </span>
      </VersionLine>
    )
  }
  if (!status) return null
  return (
    <VersionLine>
      <span className="font-mono text-foreground/85">Server {status.currentVersion}</span>
      <VersionState handle={handle} />
      <span className="ml-auto flex shrink-0 items-center">
        {notice.kind === 'available' && notice.canUpdate ? (
          <Button
            type="button"
            variant="primary"
            size="compact"
            disabled={snapshot.starting}
            onClick={() => void handle.update(notice.to)}
          >
            Update to {notice.to}
          </Button>
        ) : notice.kind === 'failed' ? (
          <Button
            type="button"
            variant="ghost"
            size="compact"
            className="text-foreground"
            onClick={() => void handle.update(notice.to)}
          >
            Try again
          </Button>
        ) : notice.kind === 'none' || notice.kind === 'updated' ? (
          <IconAction
            label="Check for a server update"
            icon={ArrowClockwiseIcon}
            onClick={() => void handle.refresh({ check: true })}
          />
        ) : null}
      </span>
    </VersionLine>
  )
}

function VersionLine({ children }: { children: React.ReactNode }) {
  return (
    <div
      aria-label="Server version"
      className="mx-1 mt-1 flex min-h-8 items-center gap-2 rounded-md bg-background/60 px-2 text-[12px]"
    >
      {children}
    </div>
  )
}

function VersionState({ handle }: { handle: ServerUpdateHandle }) {
  const { notice, snapshot } = handle
  const badge = (tone: 'ready' | 'needs' | 'muted', text: string) => (
    <span
      className={cn(
        'shrink-0 rounded px-1.5 py-px text-[11px] font-medium',
        tone === 'ready' &&
          'bg-[color-mix(in_srgb,var(--basis-session-cube-ready)_16%,transparent)] text-[var(--basis-session-cube-ready)]',
        tone === 'needs' &&
          'bg-[color-mix(in_srgb,var(--basis-session-cube-needs)_16%,transparent)] text-[var(--basis-session-cube-needs)]',
        tone === 'muted' && 'bg-active text-muted-foreground',
      )}
    >
      {text}
    </span>
  )
  switch (notice.kind) {
    case 'available':
      return (
        <>
          {badge('ready', `${notice.to} available`)}
          {notice.canUpdate ? null : (
            <span className="min-w-0 truncate text-faint" title={notice.reason}>
              {notice.reason}
            </span>
          )}
        </>
      )
    case 'updating':
      return (
        <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
          <Spinner />
          Updating{notice.to ? ` to ${notice.to}` : ''}…
        </span>
      )
    case 'updated':
      return badge('ready', `Updated from ${notice.from}`)
    case 'restart_required':
      return badge('needs', `${notice.to ?? 'Update'} installed · restart the server`)
    case 'failed':
      return (
        <span className="flex min-w-0 items-center gap-1.5" title={notice.error}>
          {badge('needs', 'Update failed')}
          <span className="min-w-0 truncate text-faint">{firstLine(notice.error)}</span>
        </span>
      )
    case 'none':
      return snapshot.error ? (
        <span className="min-w-0 truncate text-faint" title={snapshot.error}>
          {snapshot.error}
        </span>
      ) : snapshot.status?.updatedFrom ? (
        badge('ready', `Updated from ${snapshot.status.updatedFrom}`)
      ) : snapshot.status?.latestVersion ? (
        badge('muted', 'Up to date')
      ) : null
  }
}

/**
 * On the screen for a server too old for this app: update it from here when
 * it can, else say what to run on its machine.
 */
export function ServerTooOldCallout({ environmentId }: { environmentId: string | null }) {
  const handle = useServerUpdate(environmentId)
  const { notice, snapshot } = handle
  if (!environmentId) return null
  if (snapshot.unsupported || (notice.kind === 'available' && !notice.canUpdate)) {
    return (
      <p className="mt-5 rounded-lg bg-hover/70 px-3 py-2.5 text-[13px] text-muted-foreground">
        Update the server on its machine: run{' '}
        <code className="font-mono text-foreground">openmanager update</code>, then Retry.
      </p>
    )
  }
  if (notice.kind === 'updating') {
    return (
      <p className="mt-5 flex items-center gap-2 rounded-lg bg-hover/70 px-3 py-2.5 text-[13px]">
        <Spinner />
        Updating the server{notice.to ? ` to ${notice.to}` : ''}… this page reconnects when it is
        back.
      </p>
    )
  }
  if (notice.kind === 'available' || notice.kind === 'failed') {
    return (
      <div className="mt-5 flex flex-col gap-2 rounded-lg bg-hover/70 p-3">
        <p className="text-[13px] text-foreground">
          {notice.kind === 'available'
            ? `Server ${notice.to} is out. Update it from here; this app reconnects when it is back.`
            : `The last update failed: ${firstLine(notice.error)}`}
        </p>
        <Button
          type="button"
          size="compact"
          className="self-start"
          leadingIcon={ArrowCircleUpIcon}
          disabled={snapshot.starting}
          onClick={() => void handle.update(notice.to)}
        >
          Update server{notice.to ? ` to ${notice.to}` : ''}
        </Button>
      </div>
    )
  }
  return null
}
