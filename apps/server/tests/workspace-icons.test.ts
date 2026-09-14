import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WORKSPACE_ICON_MAX_BYTES, resolveWorkspaceIconDataUrl } from '../src/workspace-icons.js'

const tempPaths: string[] = []

async function makeWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'openmanager-workspace-icon-'))
  tempPaths.push(dir)
  return dir
}

async function writeWorkspaceFile(
  root: string,
  relativePath: string,
  contents: string | Buffer,
): Promise<void> {
  const absolutePath = join(root, relativePath)
  await mkdir(dirname(absolutePath), { recursive: true })
  await writeFile(absolutePath, contents)
}

const decoded = (dataUrl: string | null) =>
  Buffer.from(dataUrl!.split(',')[1]!, 'base64').toString('utf8')

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('resolveWorkspaceIconDataUrl', () => {
  it('prefers openmanager.json iconPath over well-known files', async () => {
    const root = await makeWorkspace()
    await writeWorkspaceFile(root, 'favicon.svg', '<svg id="favicon"></svg>')
    await writeWorkspaceFile(root, 'brand/mark.svg', '<svg id="mark"></svg>')
    await writeWorkspaceFile(root, 'openmanager.json', JSON.stringify({ iconPath: 'brand/mark.svg' }))

    const dataUrl = await resolveWorkspaceIconDataUrl(root)

    expect(dataUrl).toMatch(/^data:image\/svg\+xml;base64,/)
    expect(decoded(dataUrl)).toContain('id="mark"')
  })

  it('falls back to well-known files when iconPath is missing or malformed', async () => {
    const root = await makeWorkspace()
    await writeWorkspaceFile(root, 'openmanager.json', JSON.stringify({ iconPath: 'brand/missing.svg' }))
    await writeWorkspaceFile(root, 'public/favicon.png', Buffer.from([137, 80, 78, 71]))
    expect(await resolveWorkspaceIconDataUrl(root)).toMatch(/^data:image\/png;base64,/)

    await writeWorkspaceFile(root, 'openmanager.json', '{not json')
    expect(await resolveWorkspaceIconDataUrl(root)).toMatch(/^data:image\/png;base64,/)

    await writeWorkspaceFile(root, 'openmanager.json', JSON.stringify({ iconPath: 42 }))
    expect(await resolveWorkspaceIconDataUrl(root)).toMatch(/^data:image\/png;base64,/)
  })

  it('returns the first existing well-known candidate in priority order', async () => {
    const root = await makeWorkspace()
    await writeWorkspaceFile(root, 'assets/logo.svg', '<svg id="logo"></svg>')
    await writeWorkspaceFile(root, 'favicon.svg', '<svg id="favicon"></svg>')
    expect(decoded(await resolveWorkspaceIconDataUrl(root))).toContain('id="favicon"')

    await writeWorkspaceFile(root, 'build/icon.png', Buffer.from([137, 80, 78, 71]))
    expect(await resolveWorkspaceIconDataUrl(root)).toMatch(/^data:image\/png;base64,/)
  })

  it('resolves Tauri and nested frontend icons when the root has none', async () => {
    const tauri = await makeWorkspace()
    await writeWorkspaceFile(tauri, 'src-tauri/icons/icon.png', Buffer.from([137, 80, 78, 71]))
    expect(await resolveWorkspaceIconDataUrl(tauri)).toMatch(/^data:image\/png;base64,/)

    const nested = await makeWorkspace()
    await writeWorkspaceFile(nested, 'frontend/src/app/favicon.ico', Buffer.from([0, 0, 1, 0]))
    expect(await resolveWorkspaceIconDataUrl(nested)).toMatch(/^data:image\/x-icon;base64,/)

    const monorepo = await makeWorkspace()
    await writeWorkspaceFile(monorepo, 'favicon.svg', '<svg id="root-favicon"></svg>')
    await writeWorkspaceFile(monorepo, 'apps/desktop/build/icon.png', Buffer.from([137, 80, 78, 71]))
    // Root favicon still wins when present.
    expect(decoded(await resolveWorkspaceIconDataUrl(monorepo))).toContain('id="root-favicon"')
  })

  it('rejects iconPath values that escape the workspace root or are absolute', async () => {
    const root = await makeWorkspace()
    const outsideFile = join(dirname(root), `openmanager-icon-secret-${Date.now()}.svg`)
    await writeFile(outsideFile, '<svg id="secret"></svg>')
    tempPaths.push(outsideFile)

    await writeWorkspaceFile(
      root,
      'openmanager.json',
      JSON.stringify({ iconPath: `../${basename(outsideFile)}` }),
    )
    expect(await resolveWorkspaceIconDataUrl(root)).toBeNull()

    await writeWorkspaceFile(root, 'openmanager.json', JSON.stringify({ iconPath: outsideFile }))
    expect(await resolveWorkspaceIconDataUrl(root)).toBeNull()
  })

  it('answers null for a folder without an icon, a missing folder, and an oversized icon', async () => {
    const root = await makeWorkspace()
    expect(await resolveWorkspaceIconDataUrl(root)).toBeNull()
    expect(await resolveWorkspaceIconDataUrl(join(root, 'nope'))).toBeNull()

    await writeWorkspaceFile(root, 'favicon.png', Buffer.alloc(WORKSPACE_ICON_MAX_BYTES + 1, 1))
    expect(await resolveWorkspaceIconDataUrl(root)).toBeNull()

    await writeWorkspaceFile(root, 'favicon.png', Buffer.alloc(0))
    expect(await resolveWorkspaceIconDataUrl(root)).toBeNull()
  })
})
