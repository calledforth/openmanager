import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PROJECT_ICON_MAX_BYTES, resolveWorkspaceIconDataUrl } from './project-icon'

const tempDirs: string[] = []

async function makeTempWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'openmanager-project-icon-'))
  tempDirs.push(dir)
  return dir
}

async function writeWorkspaceFile(
  workspaceRoot: string,
  relativePath: string,
  contents: string | Buffer,
): Promise<void> {
  const absolutePath = join(workspaceRoot, relativePath)
  await mkdir(dirname(absolutePath), { recursive: true })
  await writeFile(absolutePath, contents)
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('resolveWorkspaceIconDataUrl', () => {
  it('prefers openmanager.json iconPath over well-known files', async () => {
    const cwd = await makeTempWorkspace()
    await writeWorkspaceFile(cwd, 'favicon.svg', '<svg id="favicon"></svg>')
    await writeWorkspaceFile(cwd, 'brand/mark.svg', '<svg id="mark"></svg>')
    await writeWorkspaceFile(
      cwd,
      'openmanager.json',
      JSON.stringify({ iconPath: 'brand/mark.svg' }),
    )

    const dataUrl = await resolveWorkspaceIconDataUrl(cwd)

    expect(dataUrl).toMatch(/^data:image\/svg\+xml;base64,/)
    expect(Buffer.from(dataUrl!.split(',')[1]!, 'base64').toString('utf8')).toContain('id="mark"')
  })

  it('falls back to well-known files when iconPath is missing', async () => {
    const cwd = await makeTempWorkspace()
    await writeWorkspaceFile(
      cwd,
      'openmanager.json',
      JSON.stringify({ iconPath: 'brand/missing.svg' }),
    )
    await writeWorkspaceFile(cwd, 'public/favicon.png', Buffer.from([137, 80, 78, 71]))

    const dataUrl = await resolveWorkspaceIconDataUrl(cwd)

    expect(dataUrl).toMatch(/^data:image\/png;base64,/)
  })

  it('returns the first existing well-known candidate', async () => {
    const cwd = await makeTempWorkspace()
    await writeWorkspaceFile(cwd, 'assets/logo.svg', '<svg id="logo"></svg>')
    await writeWorkspaceFile(cwd, 'favicon.svg', '<svg id="favicon"></svg>')

    const dataUrl = await resolveWorkspaceIconDataUrl(cwd)

    expect(Buffer.from(dataUrl!.split(',')[1]!, 'base64').toString('utf8')).toContain(
      'id="favicon"',
    )
  })

  it('prefers Electron build/icon over web favicons', async () => {
    const cwd = await makeTempWorkspace()
    await writeWorkspaceFile(cwd, 'favicon.svg', '<svg id="favicon"></svg>')
    await writeWorkspaceFile(cwd, 'build/icon.png', Buffer.from([137, 80, 78, 71]))

    const dataUrl = await resolveWorkspaceIconDataUrl(cwd)

    expect(dataUrl).toMatch(/^data:image\/png;base64,/)
  })

  it('resolves Tauri src-tauri/icons/icon.png', async () => {
    const cwd = await makeTempWorkspace()
    await writeWorkspaceFile(cwd, 'src-tauri/icons/icon.png', Buffer.from([137, 80, 78, 71]))

    const dataUrl = await resolveWorkspaceIconDataUrl(cwd)

    expect(dataUrl).toMatch(/^data:image\/png;base64,/)
  })

  it('resolves favicons under a nested frontend package', async () => {
    const cwd = await makeTempWorkspace()
    await writeWorkspaceFile(cwd, 'frontend/src/app/favicon.ico', Buffer.from([0, 0, 1, 0]))

    const dataUrl = await resolveWorkspaceIconDataUrl(cwd)

    expect(dataUrl).toMatch(/^data:image\/x-icon;base64,/)
  })

  it('resolves Electron icons under apps/desktop in a monorepo', async () => {
    const cwd = await makeTempWorkspace()
    await writeWorkspaceFile(cwd, 'favicon.svg', '<svg id="root-favicon"></svg>')
    await writeWorkspaceFile(cwd, 'apps/desktop/build/icon.png', Buffer.from([137, 80, 78, 71]))

    // Root favicon still wins when present.
    const withRoot = await resolveWorkspaceIconDataUrl(cwd)
    expect(Buffer.from(withRoot!.split(',')[1]!, 'base64').toString('utf8')).toContain(
      'id="root-favicon"',
    )
  })

  it('falls back to apps/desktop build icon when root has none', async () => {
    const cwd = await makeTempWorkspace()
    await writeWorkspaceFile(cwd, 'apps/desktop/build/icon.png', Buffer.from([137, 80, 78, 71]))

    const dataUrl = await resolveWorkspaceIconDataUrl(cwd)

    expect(dataUrl).toMatch(/^data:image\/png;base64,/)
  })

  it('rejects iconPath outside the workspace root', async () => {
    const cwd = await makeTempWorkspace()
    const outsideFile = join(dirname(cwd), `openmanager-icon-secret-${Date.now()}.svg`)
    await writeFile(outsideFile, '<svg id="secret"></svg>')
    tempDirs.push(outsideFile)
    await writeWorkspaceFile(
      cwd,
      'openmanager.json',
      JSON.stringify({ iconPath: `../${outsideFile.split(/[/\\]/).pop()}` }),
    )

    expect(await resolveWorkspaceIconDataUrl(cwd)).toBeNull()
  })

  it('returns null when no icon exists', async () => {
    const cwd = await makeTempWorkspace()
    expect(await resolveWorkspaceIconDataUrl(cwd)).toBeNull()
  })

  it('skips icons larger than the size cap', async () => {
    const cwd = await makeTempWorkspace()
    await writeWorkspaceFile(cwd, 'favicon.png', Buffer.alloc(PROJECT_ICON_MAX_BYTES + 1, 1))
    expect(await resolveWorkspaceIconDataUrl(cwd)).toBeNull()
  })
})
