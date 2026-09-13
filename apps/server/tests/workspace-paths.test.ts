import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  canonicalizeRoot,
  isWithinRoot,
  PathBoundaryError,
  resolveWorkspacePath,
} from '../src/workspace-paths.js'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

/** A workspace root beside a directory that must stay unreachable. */
async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'openmanager-paths-'))
  directories.push(base)
  const root = join(base, 'workspace')
  const outside = join(base, 'outside')
  await mkdir(join(root, 'src'), { recursive: true })
  await mkdir(outside)
  await writeFile(join(root, 'src', 'index.ts'), 'export {}\n')
  await writeFile(join(outside, 'secret.txt'), 'secret\n')
  return { base, root: canonicalizeRoot(root), outside: canonicalizeRoot(outside) }
}

async function link(target: string, path: string) {
  // Junctions need no privilege on Windows; symlinks do. Both resolve through realpath.
  await symlink(target, path, process.platform === 'win32' ? 'junction' : 'dir')
}

const reason = (root: string, path: string) => {
  try {
    resolveWorkspacePath(root, path)
  } catch (error) {
    if (error instanceof PathBoundaryError) return error.reason
    throw error
  }
  return 'accepted'
}

describe('workspace path boundary', () => {
  it('resolves relative paths, with either separator, to canonical locations under the root', async () => {
    const { root } = await fixture()
    expect(resolveWorkspacePath(root, 'src/index.ts')).toBe(join(root, 'src', 'index.ts'))
    expect(resolveWorkspacePath(root, 'src\\index.ts')).toBe(join(root, 'src', 'index.ts'))
    expect(resolveWorkspacePath(root, './src/../src/./index.ts')).toBe(
      join(root, 'src', 'index.ts'),
    )
    expect(resolveWorkspacePath(root, '')).toBe(root)
    expect(resolveWorkspacePath(root, '.')).toBe(root)
    // Files that do not exist yet resolve through their deepest existing ancestor.
    expect(resolveWorkspacePath(root, 'src/new/file.ts')).toBe(join(root, 'src', 'new', 'file.ts'))
  })

  it('refuses absolute, drive-relative and UNC paths', async () => {
    const { root, outside } = await fixture()
    for (const path of [
      outside,
      root,
      '/etc/passwd',
      '\\Windows\\win.ini',
      'C:\\Windows',
      'C:Windows',
      '\\\\server\\share',
      '//server/share',
      '\\\\wsl$\\Ubuntu\\home',
    ]) {
      expect(reason(root, path), path).toBe('absolute')
    }
  })

  it('refuses traversal above the root and paths that merely share its prefix', async () => {
    const { root } = await fixture()
    for (const path of ['..', '../outside/secret.txt', 'src/../../outside', 'src/../../..']) {
      expect(reason(root, path), path).toBe('escape')
    }
    expect(isWithinRoot(root, `${root}-sibling${sep}file`)).toBe(false)
    expect(isWithinRoot(root, `${root}${sep}file`)).toBe(true)
    expect(isWithinRoot(root, root)).toBe(true)
  })

  it('refuses links that leave the root, even through a not-yet-existing child', async () => {
    const { root, outside } = await fixture()
    await link(outside, join(root, 'escape'))
    expect(reason(root, 'escape')).toBe('escape')
    expect(reason(root, 'escape/secret.txt')).toBe('escape')
    expect(reason(root, 'escape/new-file.txt')).toBe('escape')
    // A link that stays inside the root is fine and is returned canonicalized.
    await link(join(root, 'src'), join(root, 'alias'))
    expect(resolveWorkspacePath(root, 'alias/index.ts')).toBe(join(root, 'src', 'index.ts'))
  })

  it('refuses invalid characters and Windows device names or streams', async () => {
    const { root } = await fixture()
    expect(reason(root, 'src/\0index.ts')).toBe('invalid')
    if (process.platform === 'win32') {
      for (const path of ['NUL', 'src/CON.txt', 'src/index.ts:stream', 'com1']) {
        expect(reason(root, path), path).toBe('invalid')
      }
    }
  })

  it('canonicalizes a root through links and rejects roots that are not directories', async () => {
    const { base, root } = await fixture()
    await link(root, join(base, 'root-link'))
    expect(canonicalizeRoot(join(base, 'root-link'))).toBe(root)
    expect(() => canonicalizeRoot(join(base, 'missing'))).toThrow()
    expect(() => canonicalizeRoot(join(root, 'src', 'index.ts'))).toThrow('not a directory')
  })
})
