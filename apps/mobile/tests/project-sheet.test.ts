import { describe, expect, it } from 'vitest'
import type { WorkspaceEntry } from '@openmanager/app-core/logic'

import { projectSheetSections, projectUnavailable } from '../src/composer/project-sections'
import { recentChipsOf } from '../src/draft/recent-chips'

const entry = (name: string, extra: Partial<WorkspaceEntry> = {}): WorkspaceEntry => ({
  path: `C:/${name}`,
  name,
  ...extra,
})
const NONE = entry('scratch', { scratch: true })
const ALPHA = entry('alpha')
const BETA = entry('beta')
const GONE = entry('gone', { missing: true, availability: 'missing' })
const LOCKED = entry('locked', { availability: 'inaccessible' })

const paths = (sections: ReturnType<typeof projectSheetSections>) =>
  sections.map((section) => [section.id, section.rows.map((row) => row.name)])

describe('the project sheet', () => {
  it('lists "No project", the recents, then every other project once', () => {
    const sections = projectSheetSections(
      { workspaces: [NONE, ALPHA, BETA, GONE], recents: [BETA, NONE] },
      '',
    )
    expect(paths(sections)).toEqual([
      ['none', ['scratch']],
      ['recent', ['beta']],
      ['all', ['alpha', 'gone']],
    ])
  })

  it('never lists a recent the environment does not list itself, or one whose folder is gone', () => {
    const elsewhere = entry('elsewhere')
    const sections = projectSheetSections(
      { workspaces: [ALPHA, GONE], recents: [elsewhere, GONE, ALPHA] },
      '',
    )
    expect(paths(sections)).toEqual([
      ['recent', ['alpha']],
      ['all', ['gone']],
    ])
  })

  it('narrows one list by name or path, and finds "No project" by its other names', () => {
    const lists = { workspaces: [NONE, ALPHA, BETA], recents: [ALPHA] }
    expect(paths(projectSheetSections(lists, 'alp'))).toEqual([['none', ['alpha']]])
    expect(paths(projectSheetSections(lists, 'C:/be'))).toEqual([['none', ['beta']]])
    expect(paths(projectSheetSections(lists, 'without'))).toEqual([['none', ['scratch']]])
    expect(projectSheetSections(lists, 'zzz')).toEqual([])
  })

  it('says why a project cannot be picked', () => {
    expect(projectUnavailable(ALPHA)).toBeNull()
    expect(projectUnavailable(GONE)).toBe('Its folder is gone on the environment')
    expect(projectUnavailable(LOCKED)).toBe('The environment cannot open its folder')
  })
})

describe('the recent project chips', () => {
  it('offers up to four other projects whose folders are there, never "No project"', () => {
    const many = ['a', 'b', 'c', 'd', 'e'].map((name) => entry(name))
    expect(
      recentChipsOf([NONE, ALPHA, GONE, LOCKED, ...many], 'C:/alpha').map((w) => w.name),
    ).toEqual(['a', 'b', 'c', 'd'])
  })
})
