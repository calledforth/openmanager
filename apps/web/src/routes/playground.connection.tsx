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
          <div className="flex min-h-[220px] flex-col">
            <ConnectionBanner state={state} />
            <div className="flex flex-1 items-center justify-center px-6">
              <p className="max-w-sm text-center text-ui-sm text-[var(--basis-text-muted)]">
                Session workspace stays mounted while {state.kind.replace('_', ' ')}.
              </p>
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
        Storybook equivalent for first-run and failure surfaces. Blocking screens are for
        setup and terminal errors. Connecting, reconnecting, and unreachable stay in the
        shell as banners.
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
        When the route in use fails, the other saved routes are tried, local first. These are what a
        person sees when none of them reaches the environment.
      </p>
      <div className="mt-6 grid gap-6">
        {ROUTE_FAILURE_STORIES.map((story) => (
          <StoryCard key={story.id} {...story} />
        ))}
      </div>
    </div>
  )
}
