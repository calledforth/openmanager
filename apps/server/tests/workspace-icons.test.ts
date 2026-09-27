import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  WORKSPACE_ICON_MAX_BYTES,
  WORKSPACE_ICON_SOURCE_MAX_BYTES,
  createWorkspaceIconCache,
  declaredHrefCandidates,
  extractDeclaredIconHrefs,
  extractManifestIconHrefs,
  extractNextMetadataIconHrefs,
  resolveWorkspaceIconDataUrl,
} from '../src/workspace-icons.js'

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
    await writeWorkspaceFile(
      root,
      'openmanager.json',
      JSON.stringify({ iconPath: 'brand/mark.svg' }),
    )

    const dataUrl = await resolveWorkspaceIconDataUrl(root)

    expect(dataUrl).toMatch(/^data:image\/svg\+xml;base64,/)
    expect(decoded(dataUrl)).toContain('id="mark"')
  })

  it('falls back to well-known files when iconPath is missing or malformed', async () => {
    const root = await makeWorkspace()
    await writeWorkspaceFile(
      root,
      'openmanager.json',
      JSON.stringify({ iconPath: 'brand/missing.svg' }),
    )
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
    await writeWorkspaceFile(
      monorepo,
      'apps/desktop/build/icon.png',
      Buffer.from([137, 80, 78, 71]),
    )
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

  it('does not follow links inside the workspace that point outside it', async () => {
    const root = await makeWorkspace()
    const outside = await makeWorkspace()
    await writeWorkspaceFile(outside, 'icon.svg', '<svg id="secret"></svg>')
    await writeWorkspaceFile(outside, 'favicon.svg', '<svg id="secret"></svg>')

    // A well-known candidate directory that is a link out of the workspace.
    await symlink(outside, join(root, 'assets'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(await resolveWorkspaceIconDataUrl(root)).toBeNull()

    // A configured iconPath that is a link out of the workspace.
    await writeWorkspaceFile(
      root,
      'openmanager.json',
      JSON.stringify({ iconPath: 'assets/icon.svg' }),
    )
    expect(await resolveWorkspaceIconDataUrl(root)).toBeNull()

    // A nested package root that is a link out of the workspace.
    await symlink(
      outside,
      join(root, 'frontend'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    expect(await resolveWorkspaceIconDataUrl(root)).toBeNull()

    // A real file beside the links still resolves.
    await writeWorkspaceFile(root, 'favicon.png', Buffer.from([137, 80, 78, 71]))
    expect(await resolveWorkspaceIconDataUrl(root)).toMatch(/^data:image\/png;base64,/)
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

const PNG = Buffer.from([137, 80, 78, 71])
const linkKind = process.platform === 'win32' ? 'junction' : 'dir'

describe('declared icons', () => {
  it('reads <link rel="icon"> from index.html and finds the href under public/', async () => {
    const root = await makeWorkspace()
    await writeWorkspaceFile(
      root,
      'index.html',
      '<head><link href="/brand.svg" rel="icon" type="image/svg+xml"></head>',
    )
    await writeWorkspaceFile(root, 'public/brand.svg', '<svg id="brand"></svg>')
    expect(decoded(await resolveWorkspaceIconDataUrl(root))).toContain('id="brand"')
  })

  it('reads link hrefs relative to the declaring file and at the app root', async () => {
    const root = await makeWorkspace()
    await writeWorkspaceFile(
      root,
      'src/index.html',
      '<link rel="shortcut icon" href="img/mark.png">',
    )
    await writeWorkspaceFile(root, 'src/img/mark.png', PNG)
    expect(await resolveWorkspaceIconDataUrl(root)).toMatch(/^data:image\/png;base64,/)

    const atRoot = await makeWorkspace()
    await writeWorkspaceFile(atRoot, 'index.html', "<link rel='icon' href='/mark.svg?v=2'>")
    await writeWorkspaceFile(atRoot, 'mark.svg', '<svg id="root-mark"></svg>')
    expect(decoded(await resolveWorkspaceIconDataUrl(atRoot))).toContain('id="root-mark"')
  })

  it('reads { rel: "icon", href } metadata from a root route', async () => {
    const root = await makeWorkspace()
    await writeWorkspaceFile(
      root,
      'src/routes/__root.tsx',
      "export const Route = createRootRoute({ head: () => ({ links: [{ rel: 'stylesheet', href: '/app.css' }, { href: '/logo.svg', rel: 'icon' }] }) })",
    )
    await writeWorkspaceFile(root, 'public/logo.svg', '<svg id="route"></svg>')
    expect(decoded(await resolveWorkspaceIconDataUrl(root))).toContain('id="route"')
  })

  it('reads Next metadata.icons from a root layout', async () => {
    const root = await makeWorkspace()
    await writeWorkspaceFile(
      root,
      'src/app/layout.tsx',
      "export const metadata = { title: 'x', icons: { icon: [{ url: '/brand/icon.png' }] } }",
    )
    await writeWorkspaceFile(root, 'public/brand/icon.png', PNG)
    expect(await resolveWorkspaceIconDataUrl(root)).toMatch(/^data:image\/png;base64,/)
  })

  it('reads the largest web app manifest icon, skipping monochrome ones', async () => {
    const root = await makeWorkspace()
    await writeWorkspaceFile(
      root,
      'public/site.webmanifest',
      JSON.stringify({
        icons: [
          { src: '/small.svg', sizes: '48x48' },
          { src: '/mono.svg', sizes: '1024x1024', purpose: 'monochrome' },
          { src: '/large.svg', sizes: '192x192 512x512' },
        ],
      }),
    )
    await writeWorkspaceFile(root, 'public/small.svg', '<svg id="small"></svg>')
    await writeWorkspaceFile(root, 'public/mono.svg', '<svg id="mono"></svg>')
    await writeWorkspaceFile(root, 'public/large.svg', '<svg id="large"></svg>')
    expect(decoded(await resolveWorkspaceIconDataUrl(root))).toContain('id="large"')
  })

  it('reads a browser-extension manifest in a top-level folder, relative to that folder', async () => {
    const root = await makeWorkspace()
    await writeWorkspaceFile(
      root,
      'extension/manifest.json',
      JSON.stringify({ icons: { '16': 'assets/icon-16.svg', '128': 'assets/icon-128.svg' } }),
    )
    await writeWorkspaceFile(root, 'extension/assets/icon-16.svg', '<svg id="16"></svg>')
    await writeWorkspaceFile(root, 'extension/assets/icon-128.svg', '<svg id="128"></svg>')
    expect(decoded(await resolveWorkspaceIconDataUrl(root))).toContain('id="128"')
  })

  it('does not scan dependency, build-output, or dot folders', async () => {
    const root = await makeWorkspace()
    for (const dir of ['node_modules', 'dist', '.cache']) {
      await writeWorkspaceFile(root, `${dir}/index.html`, '<link rel="icon" href="mark.svg">')
      await writeWorkspaceFile(root, `${dir}/mark.svg`, '<svg></svg>')
    }
    expect(await resolveWorkspaceIconDataUrl(root)).toBeNull()
  })

  it('does not scan gitignored top-level folders or nested repositories', async () => {
    const root = await makeWorkspace()
    const manifest = JSON.stringify({ icons: { '128': 'mark.svg' } })
    for (const dir of ['storybook-static', 'generated', 'reference', 'clone']) {
      await writeWorkspaceFile(root, `${dir}/manifest.json`, manifest)
      await writeWorkspaceFile(root, `${dir}/mark.svg`, `<svg id="${dir}"></svg>`)
    }
    await writeWorkspaceFile(root, '.gitignore', '# output\ngenerated/\n/reference\n*.log\n')
    await writeWorkspaceFile(root, 'clone/.git/HEAD', 'ref: refs/heads/main\n')
    expect(await resolveWorkspaceIconDataUrl(root)).toBeNull()

    // A plain top-level folder beside them is still read.
    await writeWorkspaceFile(root, 'extension/manifest.json', manifest)
    await writeWorkspaceFile(root, 'extension/mark.svg', '<svg id="extension"></svg>')
    expect(decoded(await resolveWorkspaceIconDataUrl(root))).toContain('id="extension"')
  })

  it('keeps well-known files ahead of declared icons', async () => {
    const root = await makeWorkspace()
    await writeWorkspaceFile(root, 'index.html', '<link rel="icon" href="/declared.svg">')
    await writeWorkspaceFile(root, 'declared.svg', '<svg id="declared"></svg>')
    await writeWorkspaceFile(root, 'apps/web/public/favicon.svg', '<svg id="well-known"></svg>')
    expect(decoded(await resolveWorkspaceIconDataUrl(root))).toContain('id="well-known"')
  })

  it('rejects declared hrefs that escape the root, are absolute, or are URLs', async () => {
    const root = await makeWorkspace()
    const outside = join(dirname(root), `openmanager-declared-secret-${Date.now()}.svg`)
    await writeFile(outside, '<svg id="secret"></svg>')
    tempPaths.push(outside)
    const name = basename(outside)
    const absolute = outside.replace(/\\/g, '/')

    const hrefs = [
      `../${name}`,
      `/../${name}`,
      `%2e%2e/${name}`,
      absolute,
      `file:///${absolute}`,
      'https://example.com/favicon.svg',
      '//example.com/favicon.svg',
      'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
    ]
    for (const href of hrefs) {
      await writeWorkspaceFile(root, 'index.html', `<link rel="icon" href="${href}">`)
      await writeWorkspaceFile(root, 'manifest.json', JSON.stringify({ icons: [{ src: href }] }))
      expect(await resolveWorkspaceIconDataUrl(root), href).toBeNull()
    }
  })

  it('does not follow a declared href or a top-level folder through a link out of the root', async () => {
    const root = await makeWorkspace()
    const outside = await makeWorkspace()
    await writeWorkspaceFile(outside, 'mark.svg', '<svg id="secret"></svg>')
    await writeWorkspaceFile(
      outside,
      'manifest.json',
      JSON.stringify({ icons: { '128': 'mark.svg' } }),
    )

    await symlink(outside, join(root, 'brand'), linkKind)
    await writeWorkspaceFile(root, 'index.html', '<link rel="icon" href="/brand/mark.svg">')
    expect(await resolveWorkspaceIconDataUrl(root)).toBeNull()

    // `brand` also holds a manifest, but a linked folder is never scanned.
    await rm(join(root, 'index.html'))
    expect(await resolveWorkspaceIconDataUrl(root)).toBeNull()
  })

  it('answers null for declared icons that are missing, oversized, or not images', async () => {
    const root = await makeWorkspace()
    await writeWorkspaceFile(root, 'index.html', '<link rel="icon" href="/missing.svg">')
    expect(await resolveWorkspaceIconDataUrl(root)).toBeNull()

    await writeWorkspaceFile(root, 'index.html', '<link rel="icon" href="/big.png">')
    await writeWorkspaceFile(root, 'public/big.png', Buffer.alloc(WORKSPACE_ICON_MAX_BYTES + 1, 1))
    expect(await resolveWorkspaceIconDataUrl(root)).toBeNull()

    await writeWorkspaceFile(root, 'index.html', '<link rel="icon" href="/icon.txt">')
    await writeWorkspaceFile(root, 'public/icon.txt', 'not an image')
    expect(await resolveWorkspaceIconDataUrl(root)).toBeNull()

    // An oversized source is not parsed at all.
    await writeWorkspaceFile(root, 'public/ok.svg', '<svg></svg>')
    await writeWorkspaceFile(
      root,
      'index.html',
      `<link rel="icon" href="/ok.svg">${' '.repeat(WORKSPACE_ICON_SOURCE_MAX_BYTES)}`,
    )
    expect(await resolveWorkspaceIconDataUrl(root)).toBeNull()

    // A malformed manifest, or one without icons, is ignored.
    await rm(join(root, 'index.html'))
    await writeWorkspaceFile(root, 'manifest.json', '{not json')
    expect(await resolveWorkspaceIconDataUrl(root)).toBeNull()
    await writeWorkspaceFile(root, 'manifest.json', JSON.stringify({ name: 'x' }))
    expect(await resolveWorkspaceIconDataUrl(root)).toBeNull()
  })

  it('falls through to the next declared icon when one cannot be read', async () => {
    const root = await makeWorkspace()
    await writeWorkspaceFile(
      root,
      'index.html',
      '<link rel="apple-touch-icon" href="/touch.png"><link rel="icon" href="/gone.svg"><link rel="icon" href="/here.svg">',
    )
    await writeWorkspaceFile(root, 'public/touch.png', PNG)
    await writeWorkspaceFile(root, 'public/here.svg', '<svg id="here"></svg>')
    expect(decoded(await resolveWorkspaceIconDataUrl(root))).toContain('id="here"')
  })
})

describe('declared icon parsing', () => {
  it('extracts favicon links before touch icons and ignores other rels', () => {
    expect(
      extractDeclaredIconHrefs(
        '<link rel="apple-touch-icon" href="/t.png"><link rel="mask-icon" href="/m.svg"><link rel="stylesheet" href="/s.css"><LINK REL="Shortcut Icon" HREF="/f.ico">',
      ),
    ).toEqual(['/f.ico', '/t.png'])
  })

  it('scans a source full of unclosed link tags in linear time', () => {
    const started = performance.now()
    expect(extractDeclaredIconHrefs('<link '.repeat(WORKSPACE_ICON_SOURCE_MAX_BYTES / 6))).toEqual(
      [],
    )
    expect(
      extractDeclaredIconHrefs('<link<link'.repeat(WORKSPACE_ICON_SOURCE_MAX_BYTES / 10)),
    ).toEqual([])
    // Quadratic scanning took over ten seconds here; linear takes milliseconds.
    expect(performance.now() - started).toBeLessThan(1000)
  })

  it('extracts Next metadata icon paths in their common shapes', () => {
    expect(extractNextMetadataIconHrefs("metadata = { icons: '/a.png' }")).toEqual(['/a.png'])
    expect(extractNextMetadataIconHrefs('icons: { icon: "/b.svg?v=1", apple: "/c.png" }')).toEqual([
      '/b.svg',
    ])
    expect(extractNextMetadataIconHrefs("icons: { other: 'lucide' }")).toEqual([])
  })

  it('orders manifest icons by size, treating `any` as largest', () => {
    expect(
      extractManifestIconHrefs(
        JSON.stringify({
          icons: [
            { src: 'a.png', sizes: '64x64' },
            { src: 'b.svg', sizes: 'any' },
            { src: 'c.png' },
          ],
        }),
      ),
    ).toEqual(['b.svg', 'a.png', 'c.png'])
    expect(extractManifestIconHrefs('[]')).toEqual([])
  })

  it('maps hrefs to candidate paths under the app folder', () => {
    expect(declaredHrefCandidates('web', 'web', '/x.png')).toEqual([
      'web/public/x.png',
      'web/x.png',
    ])
    expect(declaredHrefCandidates('', 'src', './x.png')).toEqual([
      'src/x.png',
      'public/x.png',
      'x.png',
    ])
    expect(declaredHrefCandidates('', '', 'https://a/x.png')).toEqual([])
    expect(declaredHrefCandidates('', '', 'C:/x.png')).toEqual([])
  })
})

describe('createWorkspaceIconCache', () => {
  it('keeps hits and misses for their TTLs, re-reading a kept hit each time', async () => {
    let now = 0
    const cache = createWorkspaceIconCache({ now: () => now, hitTtlMs: 1000, missTtlMs: 100 })
    const root = await makeWorkspace()

    expect(await cache.resolve(root)).toBeNull()
    await writeWorkspaceFile(root, 'favicon.svg', '<svg id="one"></svg>')
    // The miss is kept for its TTL...
    expect(await cache.resolve(root)).toBeNull()
    now = 101
    // ...then looked up again.
    expect(decoded(await cache.resolve(root))).toContain('id="one"')

    // A kept hit re-reads the file, so an edit shows at once.
    await writeWorkspaceFile(root, 'favicon.svg', '<svg id="two"></svg>')
    expect(decoded(await cache.resolve(root))).toContain('id="two"')

    // A deleted icon falls through to a fresh lookup instead of waiting out the TTL.
    await writeWorkspaceFile(root, 'public/favicon.png', PNG)
    await unlink(join(root, 'favicon.svg'))
    expect(await cache.resolve(root)).toMatch(/^data:image\/png;base64,/)
  })

  it('invalidates on request and evicts the least recently used root', async () => {
    const cache = createWorkspaceIconCache({ capacity: 1 })
    const a = await makeWorkspace()
    const b = await makeWorkspace()

    expect(await cache.resolve(a)).toBeNull()
    await writeWorkspaceFile(a, 'favicon.svg', '<svg id="a"></svg>')
    cache.invalidate(a)
    expect(decoded(await cache.resolve(a))).toContain('id="a"')

    expect(await cache.resolve(b)).toBeNull()
    await writeWorkspaceFile(b, 'favicon.svg', '<svg id="b"></svg>')
    // Resolving `a` again evicts `b`'s kept miss.
    expect(decoded(await cache.resolve(a))).toContain('id="a"')
    expect(decoded(await cache.resolve(b))).toContain('id="b"')
  })

  it('shares one lookup between concurrent callers and drops it on invalidate', async () => {
    const cache = createWorkspaceIconCache()
    const root = await makeWorkspace()
    await writeWorkspaceFile(root, 'favicon.svg', '<svg id="shared"></svg>')
    const [first, second] = await Promise.all([cache.resolve(root), cache.resolve(root)])
    expect(first).toBe(second)
    expect(decoded(first)).toContain('id="shared"')

    // A walk that an invalidate overtakes is answered but not kept.
    await unlink(join(root, 'favicon.svg'))
    cache.invalidate(root)
    const racing = cache.resolve(root)
    cache.invalidate(root)
    expect(await racing).toBeNull()
    await writeWorkspaceFile(root, 'favicon.svg', '<svg id="after"></svg>')
    expect(decoded(await cache.resolve(root))).toContain('id="after"')
  })

  it('does not keep an answer for a folder that is gone', async () => {
    const cache = createWorkspaceIconCache()
    const parent = await makeWorkspace()
    const root = join(parent, 'later')
    expect(await cache.resolve(root)).toBeNull()
    await writeWorkspaceFile(root, 'favicon.svg', '<svg id="later"></svg>')
    expect(decoded(await cache.resolve(root))).toContain('id="later"')
  })
})
