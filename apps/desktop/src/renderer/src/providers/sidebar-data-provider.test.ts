import { describe, expect, it } from 'vitest'
import { resolveInitialWorkspacePath } from './sidebar-data-provider'

const workspaces = [{ path: '/repos/alpha' }, { path: '/repos/beta' }]

describe('resolveInitialWorkspacePath', () => {
  it('restores the last active workspace when it is still registered', () => {
    expect(resolveInitialWorkspacePath(workspaces, '/repos/beta')).toBe('/repos/beta')
  })

  it('falls back to the first registered workspace when the saved path is stale', () => {
    expect(resolveInitialWorkspacePath(workspaces, '/repos/removed')).toBe('/repos/alpha')
  })

  it('returns null when no workspace has been added', () => {
    expect(resolveInitialWorkspacePath([], '/repos/beta')).toBeNull()
  })
})
