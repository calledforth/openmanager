import { useCallback, useEffect, useMemo, useRef } from 'react'
import { ChatCircleIcon, GearIcon, PulseIcon } from '@phosphor-icons/react'
import { Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router'
import {
  useActiveSession,
  useEnvironmentClientOptional,
} from '@openmanager/app-core/providers/environment-client'
import { EnvironmentApplicationProviders } from '@openmanager/app-core/providers/environment-application'
import { WorkspaceSidebar } from '@openmanager/app-core/components/sidebar/WorkspaceSidebar'
import type { EnvironmentClient } from '@openmanager/environment-client'
import { useConnection } from '../providers/connection-provider'
import { cn } from '../lib/utils'
import { promptForWorkspace } from '../lib/workspace-prompt'
import { ConnectionBanner, ConnectionScreen, ConnectionStatusChip } from './connection-surfaces'

const nav = [
  { to: '/', label: 'Sessions', icon: ChatCircleIcon },
  { to: '/settings', label: 'Settings', icon: GearIcon },
  { to: '/playground/connection', label: 'States', icon: PulseIcon },
] as const

function isSessionPath(pathname: string) {
  return pathname === '/' || pathname.startsWith('/sessions/')
}

function NavLinks({ pathname, compact = false }: { pathname: string; compact?: boolean }) {
  return (
    <nav
      className={cn('flex gap-0.5', compact ? 'flex-row' : 'flex-col px-2')}
      aria-label="Primary"
    >
      {nav.map((item) => {
        if (compact && item.to === '/') return null
        const active = item.to === '/' ? isSessionPath(pathname) : pathname === item.to
        return (
          <Link
            key={item.to}
            to={item.to}
            title={item.label}
            aria-label={compact ? item.label : undefined}
            className={cn(
              'flex items-center gap-2 rounded-md text-ui-sm transition-colors',
              compact ? 'h-7 w-7 justify-center' : 'px-2 py-1.5',
              active
                ? 'bg-[var(--basis-surface-elevated)] text-[var(--basis-text)]'
                : 'text-[var(--basis-text-muted)] hover:bg-[var(--basis-surface)] hover:text-[var(--basis-text)]',
            )}
          >
            <item.icon className="h-3.5 w-3.5" weight={active ? 'fill' : 'regular'} />
            {compact ? null : item.label}
          </Link>
        )
      })}
    </nav>
  )
}

/**
 * Keeps the URL and the environment's active session in step. A session
 * chosen in the sidebar lands on its route; opening a draft (no active
 * session) lands on the sessions root. Only *changes* navigate: the value on
 * mount is whatever the route is about to open itself.
 */
function SessionRouteSync({ pathname }: { pathname: string }) {
  const active = useActiveSession()
  const navigate = useNavigate()
  const activeSessionId = active?.sessionId ?? null
  const previousRef = useRef(activeSessionId)
  useEffect(() => {
    if (previousRef.current === activeSessionId) return
    previousRef.current = activeSessionId
    if (!isSessionPath(pathname)) return
    if (activeSessionId) {
      void navigate({ to: '/sessions/$sessionId', params: { sessionId: activeSessionId } })
    } else if (pathname !== '/') {
      void navigate({ to: '/' })
    }
  }, [activeSessionId, navigate, pathname])
  return null
}

function ConnectedShell({
  client,
  pathname,
  children,
}: {
  client: EnvironmentClient
  pathname: string
  children: React.ReactNode
}) {
  const { ui } = useConnection()
  const addWorkspace = useCallback(() => promptForWorkspace(client), [client])
  const settingsMenu = useMemo(
    () => (
      <div className="flex w-full items-center justify-between gap-2">
        <ConnectionStatusChip state={ui} />
        <NavLinks pathname={pathname} compact />
      </div>
    ),
    [pathname, ui],
  )
  return (
    <EnvironmentApplicationProviders addWorkspace={addWorkspace}>
      <SessionRouteSync pathname={pathname} />
      <WorkspaceSidebar collapsed={false} settingsMenu={settingsMenu} />
      {children}
    </EnvironmentApplicationProviders>
  )
}

export function AppShell() {
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const client = useEnvironmentClientOptional()
  const { ui, connect, retry, changeEnvironment, selectEnvironment, removeEnvironment, environments, selectedId } =
    useConnection()
  const ungated = pathname.startsWith('/playground/') || pathname === '/settings'
  const handlers = {
    onConnect: connect,
    onRetry: retry,
    onChangeEnvironment: changeEnvironment,
    onSelectEnvironment: selectEnvironment,
    onRemoveEnvironment: removeEnvironment,
  }
  const showScreen = !ungated && ui.surface === 'screen'
  const showBanner = !ungated && ui.surface === 'banner'

  const main = (
    <main className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      {showBanner ? <ConnectionBanner state={ui} handlers={handlers} /> : null}
      {showScreen ? (
        <ConnectionScreen
          state={ui}
          handlers={handlers}
          environments={environments}
          selectedId={selectedId}
        />
      ) : (
        <Outlet />
      )}
    </main>
  )

  return (
    <div className="flex h-screen w-screen min-w-0 overflow-hidden bg-[var(--basis-canvas-bg)] text-[var(--basis-text)]">
      {client ? (
        <ConnectedShell client={client} pathname={pathname}>
          {main}
        </ConnectedShell>
      ) : (
        <>
          <aside className="flex w-[var(--basis-sidebar-width)] shrink-0 flex-col border-r border-[var(--basis-border-muted)] bg-[var(--basis-canvas-bg)]">
            <div className="px-4 py-4 text-ui-sm font-medium tracking-ui text-[var(--basis-text-strong)]">
              OpenManager
            </div>
            <ConnectionStatusChip state={ui} />
            <NavLinks pathname={pathname} />
          </aside>
          {main}
        </>
      )}
    </div>
  )
}
