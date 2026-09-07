import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/sessions/$sessionId')({
  component: SessionPage,
})

function SessionPage() {
  const { sessionId } = Route.useParams()

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="border-b border-[var(--basis-border-muted)] px-5 py-3">
        <h1 className="text-ui-sm font-medium text-[var(--basis-text-strong)]">Session</h1>
        <p className="mt-0.5 font-mono text-ui-xs text-[var(--basis-text-muted)]">{sessionId}</p>
      </header>
      <div className="flex min-h-0 flex-1 items-center justify-center px-6">
        <p className="max-w-md text-center text-ui-sm leading-ui-normal text-[var(--basis-text-muted)]">
          Chat and agent activity will render here once the shared OpenManager interface moves
          behind browser-safe adapters.
        </p>
      </div>
    </div>
  )
}
