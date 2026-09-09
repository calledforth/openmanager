import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const FORBIDDEN_IMPORT = new RegExp(
  String.raw`(?:from|import\()\s*['"](?:electron(?:/[^'"]*)?|electron-store|electron-updater|node:[^'"]+|fs|path|os|child_process|net|tls|http|https|worker_threads)['"]` +
    '|' +
    String.raw`require\(\s*['"](?:electron(?:/[^'"]*)?|electron-store|electron-updater|node:[^'"]+|fs|path|os|child_process)['"]`,
)

export function findForbiddenBrowserImport(source) {
  return source.match(FORBIDDEN_IMPORT)?.[0] ?? null
}

function walk(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return walk(path)
    return [path]
  })
}

export function checkBrowserBundle(distDir) {
  const indexHtml = join(distDir, 'index.html')
  const html = readFileSync(indexHtml, 'utf8')
  if (!html.includes('id="root"')) {
    throw new Error('Production index.html is missing the web root element')
  }
  if (!/\/assets\/.+?\.js/.test(html)) {
    throw new Error('Production index.html does not reference a hashed /assets script')
  }

  const redirects = readFileSync(join(distDir, '_redirects'), 'utf8')
  if (!redirects.includes('/index.html')) {
    throw new Error('SPA fallback _redirects is missing from the static output')
  }

  const files = walk(distDir).filter((path) => /\.(js|mjs|html)$/.test(path))
  for (const file of files) {
    const match = findForbiddenBrowserImport(readFileSync(file, 'utf8'))
    if (match) {
      throw new Error(`Node/Electron-only import in ${file}: ${match}`)
    }
  }

  return { filesChecked: files.length }
}

function main() {
  const distDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist')
  const result = checkBrowserBundle(distDir)
  console.log(
    `Browser bundle OK: ${result.filesChecked} files, no Node/Electron-only imports, SPA fallback present.`,
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
