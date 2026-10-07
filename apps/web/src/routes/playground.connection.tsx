import { createFileRoute } from '@tanstack/react-router'
import { ConnectionBanner, ConnectionScreen } from '../components/connection-surfaces'
import { deriveConnectionUi, type DeriveConnectionInput } from '../lib/connection-state'
import {
  CONNECTION_STORIES,
  READY_CONNECTION_INPUT,
  ROUTE_FAILURE_STORIES,
} from '../stories/connection-states'

export const Route = createFileRoute('/playground/connection')({
  component: ConnectionStoriesPage,
})

/**
 * A stand-in for the session under the strip, so a story shows what stays in
 * place: the strip floats over the page instead of pushing it down.
 */
function SessionStandIn() {
  return (
    <div className="flex flex-col gap-4 px-6 pb-8 pt-16" aria-hidden="true">
      <div className="ml-auto max-w-[70%] rounded-[14px] bg-hover px-3.5 py-2 text-[14px] text-foreground">
        Why does the build fail on Windows only?
      </div>
      <div className="max-w-[80%] text-[14px] leading-6 text-muted-foreground">
        The test temp directory resolves to an 8.3 short path on the Windows runner, so the lexical
        comparison misses. Comparing real paths fixes it; the session stays here while the
        connection comes back.
      </div>
    </div>
  )
}

function StoryCard({
  id,
  name,
  summary,
  input,
}: {
  id: string
  name: string
  summary: string
  input: DeriveConnectionInput
}) {
  const state = deriveConnectionUi(input)
  return (
    <section
      className="overflow-hidden rounded-md border border-[var(--basis-border-muted)]"
      aria-labelledby={`story-${id}`}
    >
      <div className="border-b border-[var(--basis-border-muted)] px-4 py-3">
        <h2 id={`story-${id}`} className="text-ui-sm font-medium text-[var(--basis-text-strong)]">
          {name}
        </h2>
        <p className="mt-1 text-ui-xs text-[var(--basis-text-muted)]">{summary}</p>
        <p className="mt-1 font-mono text-ui-xs text-[var(--basis-text-faint)]">
          {state.kind} · {state.surface}
          {state.reason ? ` · ${state.reason}` : ''}
        </p>
      </div>
      <div className="min-h-[220px] bg-[var(--basis-canvas-bg)]">
        {state.surface === 'banner' ? (
          <div className="relative min-h-[220px]">
            <SessionStandIn />
            <div className="pointer-events-none absolute inset-x-0 top-3 flex justify-center px-3">
              <ConnectionBanner className="pointer-events-auto" state={state} />
            </div>
          </div>
        ) : (
          <ConnectionScreen state={state} />
        )}
      </div>
    </section>
  )
}

function ConnectionStoriesPage() {
  const ready = deriveConnectionUi(READY_CONNECTION_INPUT)

  return (
    <div className="min-h-0 flex-1 overflow-auto px-8 py-8">
      <h1 className="text-ui-base font-medium text-[var(--basis-text-strong)]">
        Connection states
      </h1>
      <p className="mt-1 max-w-2xl text-ui-sm leading-ui-normal text-[var(--basis-text-muted)]">
        Storybook equivalent for first-run and failure surfaces. Blocking screens are for setup and
        failures only a person can fix. Everything that waiting resolves is one strip over the page:
        the environment it cannot reach, a spinner, and the cause on one muted line.
      </p>

      <section className="mt-8">
        <h2 className="text-ui-sm font-medium text-[var(--basis-text)]">Ready</h2>
        <p className="mt-1 text-ui-xs text-[var(--basis-text-muted)]">
          {ready.title}: {ready.description}
        </p>
      </section>

      <div className="mt-8 grid gap-6">
        {CONNECTION_STORIES.map((story) => (
          <StoryCard key={story.id} {...story} />
        ))}
      </div>

      <h2 className="mt-12 text-ui-base font-medium text-[var(--basis-text-strong)]">
        Route failures
      </h2>
      <p className="mt-1 max-w-2xl text-ui-sm leading-ui-normal text-[var(--basis-text-muted)]">
        When the route in use fails, the other saved routes are tried, local first. Every reason but
        a refused token shows the same reconnect strip; only its detail line differs.
      </p>
      <div className="mt-6 grid gap-6">
        {ROUTE_FAILURE_STORIES.map((story) => (
          <StoryCard key={story.id} {...story} />
        ))}
      </div>
    </div>
  )
}
