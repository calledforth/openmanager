import { describe, expect, it } from 'vitest'
import {
  addTarget,
  asFolderInput,
  folderName,
  splitBrowseInput,
  visibleFolders,
} from '../src/components/workspace/folder-browser'

const entry = (parent: string, name: string) => ({
  name,
  path: `${parent}${parent.endsWith('\\') || parent.endsWith('/') ? '' : parent.includes('\\') ? '\\' : '/'}${name}`,
})

describe('splitBrowseInput', () => {
  it('lists up to the last separator and filters by the rest', () => {
    expect(splitBrowseInput('C:\\Users\\you\\co')).toEqual({
      folder: 'C:\\Users\\you\\',
      filter: 'co',
    })
    expect(splitBrowseInput('/home/you/')).toEqual({ folder: '/home/you/', filter: '' })
    expect(splitBrowseInput('~/code/open')).toEqual({ folder: '~/code/', filter: 'open' })
    expect(splitBrowseInput('C:\\Users/mixed')).toEqual({ folder: 'C:\\Users/', filter: 'mixed' })
  })

  it('reads ~ alone as home and a bare name as no folder yet', () => {
    expect(splitBrowseInput('~')).toEqual({ folder: '~', filter: '' })
    expect(splitBrowseInput('code')).toEqual({ folder: null, filter: 'code' })
    expect(splitBrowseInput('')).toEqual({ folder: null, filter: '' })
  })
})

describe('asFolderInput', () => {
  it('ends a folder with its own separator, and leaves roots alone', () => {
    expect(asFolderInput('C:\\Users')).toBe('C:\\Users\\')
    expect(asFolderInput('/home/you')).toBe('/home/you/')
    expect(asFolderInput('C:\\')).toBe('C:\\')
    expect(asFolderInput('/')).toBe('/')
    expect(asFolderInput('\\\\server\\share')).toBe('\\\\server\\share\\')
  })
})

describe('visibleFolders', () => {
  const entries = ['.git', 'Code', 'code-old', 'docs'].map((name) => entry('/home', name))

  it('matches by prefix ignoring case, hiding dot folders', () => {
    expect(visibleFolders(entries, '').map((e) => e.name)).toEqual(['Code', 'code-old', 'docs'])
    expect(visibleFolders(entries, 'co').map((e) => e.name)).toEqual(['Code', 'code-old'])
    expect(visibleFolders(entries, 'x')).toEqual([])
  })

  it('shows dot folders once the filter asks for one', () => {
    expect(visibleFolders(entries, '.').map((e) => e.name)).toEqual(['.git'])
  })
})

describe('addTarget', () => {
  const listing = {
    path: 'C:\\code',
    parentPath: 'C:\\',
    readable: true,
    entries: ['App', 'app-web'].map((name) => entry('C:\\code', name)),
  }

  it('is the listed folder when nothing is typed after it', () => {
    expect(addTarget(listing, '')).toBe('C:\\code')
  })

  it('prefers the exact child, then one differing only in case', () => {
    expect(addTarget(listing, 'App')).toBe('C:\\code\\App')
    expect(addTarget(listing, 'app')).toBe('C:\\code\\App')
  })

  it('has nothing to add for a partial or unknown name', () => {
    expect(addTarget(listing, 'Ap')).toBeNull()
    expect(addTarget(listing, 'new')).toBeNull()
  })
})

describe('folderName', () => {
  it('is the last segment, or the root itself', () => {
    expect(folderName('C:\\Users\\you')).toBe('you')
    expect(folderName('/home/you/')).toBe('you')
    expect(folderName('C:\\')).toBe('C:\\')
    expect(folderName('/')).toBe('/')
  })
})
