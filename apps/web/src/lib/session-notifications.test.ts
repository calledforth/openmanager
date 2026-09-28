import { describe, expect, it } from 'vitest'
import {
  NOTIFICATIONS_STORAGE_KEY,
  readNotificationsEnabled,
  sessionNotice,
  writeNotificationsEnabled,
} from './session-notifications'

describe('sessionNotice', () => {
  it('is silent on first sight and on no change', () => {
    expect(sessionNotice(undefined, 'done')).toBeNull()
    expect(sessionNotice(undefined, 'waiting')).toBeNull()
    expect(sessionNotice('running', 'running')).toBeNull()
  })

  it('announces a turn that ends, including one acknowledged on the way', () => {
    expect(sessionNotice('running', 'done')).toBe('done')
    expect(sessionNotice('running', 'ready')).toBe('done')
    expect(sessionNotice('busy', 'done')).toBe('done')
  })

  it('announces a stop for input from any state', () => {
    expect(sessionNotice('running', 'waiting')).toBe('waiting')
    expect(sessionNotice('ready', 'waiting')).toBe('waiting')
  })

  it('announces a failed turn', () => {
    expect(sessionNotice('running', 'error')).toBe('error')
  })

  it('stays quiet for changes that are not news', () => {
    expect(sessionNotice('ready', 'running')).toBeNull()
    expect(sessionNotice('waiting', 'running')).toBeNull()
    expect(sessionNotice('done', 'ready')).toBeNull()
    expect(sessionNotice('waiting', 'ready')).toBeNull()
    expect(sessionNotice('ready', 'error')).toBeNull()
  })
})

describe('notifications preference', () => {
  it('defaults on and round-trips off', () => {
    const map = new Map<string, string>()
    const storage = {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => void map.set(key, value),
    }
    expect(readNotificationsEnabled(storage)).toBe(true)
    writeNotificationsEnabled(storage, false)
    expect(map.get(NOTIFICATIONS_STORAGE_KEY)).toBe('off')
    expect(readNotificationsEnabled(storage)).toBe(false)
    writeNotificationsEnabled(storage, true)
    expect(readNotificationsEnabled(storage)).toBe(true)
  })

  it('keeps a turned-off choice when storage refuses the write', () => {
    const broken = {
      getItem: () => 'on',
      setItem: () => {
        throw new Error('quota')
      },
    }
    writeNotificationsEnabled(broken, false)
    expect(readNotificationsEnabled(broken)).toBe(false)
    writeNotificationsEnabled(broken, true)
    expect(readNotificationsEnabled(broken)).toBe(true)
  })

  it('treats unreadable storage as on', () => {
    expect(readNotificationsEnabled(undefined)).toBe(true)
    expect(
      readNotificationsEnabled({
        getItem: () => {
          throw new Error('blocked')
        },
      }),
    ).toBe(true)
  })
})
