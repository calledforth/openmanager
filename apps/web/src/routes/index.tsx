import { Link, createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/')({
  component: HomePage,
})

function HomePage() {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-6">
      <div className="max-w-md text-center">
        <h1 className="text-ui-base font-medium text-[var(--basis-text-strong)]">
          Start a session
        </h1>
        <p className="mt-2 text-ui-sm leading-ui-normal text-[var(--basis-text-muted)]">
          The web shell matches the desktop app: sessions in the sidebar, a chat workspace, and
          settings. Environment connection lands in a later change.
        </p>
        <Link
          to="/sessions/$sessionId"
          params={{ sessionId: 'example' }}
          className="mt-5 inline-flex rounded-md bg-[var(--basis-action-bg)] px-3 py-1.5 text-ui-sm text-[var(--basis-action-fg)] hover:bg-[var(--basis-action-hover)]"
        >
          Open example session
        </Link>
      </div>
    </div>
  )
}
