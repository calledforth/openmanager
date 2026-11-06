import type { SessionNoticesState } from '../notifications/watch'

export interface NotificationsRowView {
  /** The toggle's position. */
  on: boolean
  sub: string
  /** Waiting for the saved choice or for Android's prompt. */
  busy: boolean
  /** What a press does. `settings`: only Android's settings can allow them now. */
  action: 'enable' | 'disable' | 'settings'
}

/** The Settings row for session notices; null where the phone has none (web, iOS). */
export function notificationsRow(state: SessionNoticesState): NotificationsRowView | null {
  if (state.access === 'unsupported') return null
  const busy = state.enabled === null || state.asking
  if (state.access === 'blocked') {
    return {
      on: false,
      sub: 'Blocked in Android settings. Tap to allow them there.',
      busy,
      action: 'settings',
    }
  }
  if (state.enabled && state.access === 'granted') {
    return {
      on: true,
      sub: 'Stays connected in the background, which uses some battery.',
      busy,
      action: 'disable',
    }
  }
  return {
    on: false,
    sub: 'When a session finishes, needs your input or fails.',
    busy,
    action: 'enable',
  }
}
