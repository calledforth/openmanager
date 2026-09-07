import { ChatCircleIcon, GearIcon } from '@phosphor-icons/react'
import { Link, Outlet, useRouterState } from '@tanstack/react-router'
import { cn } from '../lib/utils'

const nav = [
  { to: '/', label: 'Sessions', icon: ChatCircleIcon },
  { to: '/settings', label: 'Settings', icon: GearIcon },
] as const

export function AppShell() {
  const pathname = useRouterState({ select: (state) => state.location.pathname })

  return (
    <div className="flex h-screen w-screen min-w-0 overflow-hidden bg-[var(--basis-canvas-bg)] text-[var(--basis-text)]">
      <aside className="flex w-[var(--basis-sidebar-width)] shrink-0 flex-col border-r border-[var(--basis-border-muted)] bg-[var(--basis-canvas-bg)]">
        <div className="px-4 py-4 text-ui-sm font-medium tracking-ui text-[var(--basis-text-strong)]">
          OpenManager
        </div>
        <nav className="flex flex-col gap-0.5 px-2" aria-label="Primary">
          {nav.map((item) => {
            const active =
              item.to === '/'
                ? pathname === '/' || pathname.startsWith('/sessions/')
                : pathname === item.to
            return (
              <Link
                key={item.to}
                to={item.to}
                className={cn(
                  'flex items-center gap-2 rounded-md px-2 py-1.5 text-ui-sm transition-colors',
                  active
                    ? 'bg-[var(--basis-surface-elevated)] text-[var(--basis-text)]'
                    : 'text-[var(--basis-text-muted)] hover:bg-[var(--basis-surface)] hover:text-[var(--basis-text)]',
                )}
              >
                <item.icon className="h-3.5 w-3.5" weight={active ? 'fill' : 'regular'} />
                {item.label}
              </Link>
            )
          })}
        </nav>
      </aside>
      <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <Outlet />
      </main>
    </div>
  )
}
