import { app } from 'electron'
import { join } from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { configureStableUserDataPath } from './app-paths'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(),
    setPath: vi.fn(),
  },
}))

const getPath = vi.mocked(app.getPath)
const setPath = vi.mocked(app.setPath)

describe('configureStableUserDataPath', () => {
  beforeEach(() => {
    getPath.mockReset()
    setPath.mockReset()
  })

  it('preserves the legacy desktop data directory after package renames', () => {
    const appData = join('C:', 'Users', 'test', 'AppData', 'Roaming')
    getPath.mockImplementation((name) =>
      name === 'appData' ? appData : join(appData, '@openmanager', 'desktop'),
    )

    configureStableUserDataPath()

    expect(setPath).toHaveBeenCalledWith('userData', join(appData, 'openmanager'))
  })

  it('does not reset an already stable path', () => {
    const appData = join('C:', 'Users', 'test', 'AppData', 'Roaming')
    getPath.mockImplementation((name) =>
      name === 'appData' ? appData : join(appData, 'openmanager'),
    )

    configureStableUserDataPath()

    expect(setPath).not.toHaveBeenCalled()
  })
})
