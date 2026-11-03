import { createFileRoute } from '@tanstack/react-router'
import { useEnvironmentClientOptional } from '@openmanager/app-core/providers/environment-client'
import {
  ProviderLimitsCard,
  useLimitsRefresh,
  useProviderLimits,
} from '@openmanager/app-core/components/usage/UsageLimits'
import { useNow } from '@openmanager/app-core/lib/relative-time'

export const Route = createFileRoute('/usage')({
  component: UsagePage,
})

function UsagePage() {
  const client = useEnvironmentClientOptional()
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto px-4 pb-10 pt-4 sm:px-8">
      <div className="mx-auto w-full max-w-2xl">
        <h1 className="text-[18px] font-medium text-foreground">Usage</h1>
        <p className="mt-1 text-[13px] text-muted-foreground">
          How much of each plan limit is used, read from this environment’s sign-in.
        </p>
        {client ? (
          <ConnectedUsage />
        ) : (
          <p className="mt-8 text-[13px] text-muted-foreground">
            Connect to an environment to see its usage.
          </p>
        )}
      </div>
    </div>
  )
}

function ConnectedUsage() {
  const { entries, canRefresh, refresh } = useProviderLimits()
  // Opening the page is asking to see current numbers; the environment keeps
  // anything younger than a minute rather than reading again.
  useLimitsRefresh(entries, refresh, { maxAgeMs: 60_000, intervalMs: 5 * 60_000 })
  const now = useNow(15_000)
  if (entries.length === 0) {
    return (
      <p className="mt-8 text-[13px] text-muted-foreground">
        No provider on this environment reports usage limits.
      </p>
    )
  }
  return (
    <>
      <div className="mt-8 flex flex-col gap-3">
        {entries.map((entry) => (
          <section
            key={entry.providerId}
            aria-label={`${entry.displayName} usage`}
            className="rounded-2xl bg-hover/70 px-5 py-4"
          >
            <ProviderLimitsCard
              entry={entry}
              now={now}
              size="comfortable"
              onRefresh={canRefresh ? () => refresh(entry.providerId, 0) : undefined}
            />
          </section>
        ))}
      </div>
      <p className="mt-6 text-[12px] text-faint">
        Only Claude Code reports usage limits for now. A refresh takes up to a minute.
      </p>
    </>
  )
}
