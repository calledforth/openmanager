import { render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Row = { externalId: string; title?: string; status: string; parentExternalId?: string }

const sidebar = vi.hoisted(() => ({
  value: {
    sessionsByWorkspace: {} as Record<string, Row[]>,
    activeSessionId: null as string | null,
  },
}))

vi.mock('@openmanager/app-core/providers/sidebar-provider', () => ({
  useSidebarData: () => sidebar.value,
}))

import { SessionNotifications } from './session-notifications'

class FakeNotification {
  static permission: NotificationPermission = 'granted'
  static created: FakeNotification[] = []
  onclick: (() => void) | null = null
  close = vi.fn()
  constructor(
    public title: string,
    public options: NotificationOptions,
  ) {
    FakeNotification.created.push(this)
  }
}

function show(rows: Row[], activeSessionId: string | null = null) {
  sidebar.value = { sessionsByWorkspace: { '/repo': rows }, activeSessionId }
}

describe('SessionNotifications', () => {
  beforeEach(() => {
    FakeNotification.permission = 'granted'
    FakeNotification.created = []
    vi.stubGlobal('Notification', FakeNotification)
    window.localStorage.clear()
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    vi.spyOn(window, 'focus').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('notifies when a session finishes or needs input, not on first load', () => {
    const openSession = vi.fn()
    show([
      { externalId: 'a', title: 'Fix login', status: 'running' },
      { externalId: 'b', title: 'Old', status: 'done' },
    ])
    const view = render(<SessionNotifications openSession={openSession} />)
    expect(FakeNotification.created).toHaveLength(0)

    show([
      { externalId: 'a', title: 'Fix login', status: 'done' },
      { externalId: 'b', title: 'Old', status: 'waiting' },
    ])
    view.rerender(<SessionNotifications openSession={openSession} />)

    expect(FakeNotification.created.map((n) => [n.title, n.options.body, n.options.tag])).toEqual([
      ['Fix login', 'Finished', 'a'],
      ['Old', 'Needs your input', 'b'],
    ])

    FakeNotification.created[0]!.onclick?.()
    expect(openSession).toHaveBeenCalledWith('a')
    expect(FakeNotification.created[0]!.close).toHaveBeenCalled()
  })

  it('stays quiet for the session on screen while the window has focus', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    show([{ externalId: 'a', status: 'running' }], 'a')
    const view = render(<SessionNotifications openSession={vi.fn()} />)
    show([{ externalId: 'a', status: 'done' }], 'a')
    view.rerender(<SessionNotifications openSession={vi.fn()} />)
    expect(FakeNotification.created).toHaveLength(0)
  })

  it('skips subagent sessions, a turned-off preference, and missing permission', () => {
    show([{ externalId: 'child', parentExternalId: 'a', status: 'running' }])
    const view = render(<SessionNotifications openSession={vi.fn()} />)
    show([{ externalId: 'child', parentExternalId: 'a', status: 'done' }])
    view.rerender(<SessionNotifications openSession={vi.fn()} />)
    expect(FakeNotification.created).toHaveLength(0)

    window.localStorage.setItem('openmanager-notifications', 'off')
    show([{ externalId: 'a', status: 'running' }])
    view.rerender(<SessionNotifications openSession={vi.fn()} />)
    show([{ externalId: 'a', status: 'done' }])
    view.rerender(<SessionNotifications openSession={vi.fn()} />)
    expect(FakeNotification.created).toHaveLength(0)

    window.localStorage.clear()
    FakeNotification.permission = 'default'
    show([{ externalId: 'a', status: 'running' }])
    view.rerender(<SessionNotifications openSession={vi.fn()} />)
    show([{ externalId: 'a', status: 'error' }])
    view.rerender(<SessionNotifications openSession={vi.fn()} />)
    expect(FakeNotification.created).toHaveLength(0)
  })
})
