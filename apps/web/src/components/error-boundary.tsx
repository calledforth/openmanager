import { Component, type ErrorInfo, type ReactNode } from 'react'

export function ErrorFallback({ error, onRetry }: { error: Error; onRetry: () => void }) {
  return (
    <div className="flex min-h-full flex-1 items-center justify-center bg-[var(--basis-canvas-bg)] px-6 text-[var(--basis-text)]">
      <div className="max-w-md text-center">
        <h1 className="text-ui-base font-medium text-[var(--basis-text-strong)]">
          Something went wrong
        </h1>
        <p className="mt-2 text-ui-sm text-[var(--basis-text-muted)]">{error.message}</p>
        <button
          type="button"
          className="mt-4 rounded-md border border-[var(--basis-border)] bg-[var(--basis-surface)] px-3 py-1.5 text-ui-sm text-[var(--basis-text)] hover:bg-[var(--basis-surface-hover)]"
          onClick={onRetry}
        >
          Try again
        </button>
      </div>
    </div>
  )
}

export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('OpenManager web error boundary', error, info.componentStack)
  }

  render() {
    if (this.state.error) {
      return (
        <ErrorFallback error={this.state.error} onRetry={() => this.setState({ error: null })} />
      )
    }
    return this.props.children
  }
}
