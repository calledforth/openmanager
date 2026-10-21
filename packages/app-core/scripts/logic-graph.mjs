// The files reachable from app-core's DOM-free entry (`src/logic.ts`).
//
// `eslint.config.mjs` scopes the logic entry's import and global restrictions
// to exactly these files, so a module joins the rules the moment anything in
// the graph imports it, and leaves them when nothing does. Type-only imports
// count: a type pulled from a `.tsx` component brings that component along.
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
// The parser ESLint itself runs on, so this loads wherever the root config
// does: `typescript` is not hoisted to the root, and a filtered install (the
// server's CI job) leaves app-core without one.
import { parse } from '@typescript-eslint/parser'

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGE_NAME = '@openmanager/app-core'
export const LOGIC_ENTRY = join(packageDir, 'src', 'logic.ts')

const EXTENSIONS = ['.ts', '.tsx', '.d.ts']

/**
 * Browser globals nothing in the graph may name (ESLint) or touch while the
 * entry loads (`tests/logic-entry.test.ts`). Only `src/lib/browser-device.ts`,
 * the browser's side of `DeviceHost`, reads any of them, feature-detected.
 */
export const LOGIC_DOM_GLOBALS = [
  'window',
  'self',
  'document',
  'navigator',
  'location',
  'history',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'matchMedia',
  'getComputedStyle',
  'getSelection',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'requestIdleCallback',
  'cancelIdleCallback',
  'ResizeObserver',
  'IntersectionObserver',
  'MutationObserver',
  'Document',
  'Window',
  'Element',
  'HTMLElement',
  'Node',
  'Event',
  'CustomEvent',
  'KeyboardEvent',
  'MouseEvent',
  'PointerEvent',
  'FocusEvent',
  'DOMParser',
  'FileReader',
  'Image',
  'addEventListener',
  'removeEventListener',
  'alert',
  'confirm',
  'prompt',
  'screen',
  'visualViewport',
  'innerWidth',
  'innerHeight',
  'scrollTo',
  'scrollBy',
  'scrollX',
  'scrollY',
  'devicePixelRatio',
  'parent',
  'top',
  'opener',
  'frames',
  'print',
  'customElements',
  'CSS',
  'Worker',
  'SharedWorker',
  'caches',
  'DocumentFragment',
  'ShadowRoot',
  'Range',
  'Selection',
  'HTMLInputElement',
  'HTMLTextAreaElement',
  'HTMLButtonElement',
  'HTMLDivElement',
  'HTMLImageElement',
  'HTMLCanvasElement',
  'HTMLAnchorElement',
  'SVGElement',
  'UIEvent',
  'InputEvent',
  'TouchEvent',
  'WheelEvent',
  'DragEvent',
  'ClipboardEvent',
  'DataTransfer',
]

/**
 * Packages (and their subpaths) the graph may not import: the web UI's stack.
 * ESLint adds the `@radix-ui`, `@base-ui`, `@shikijs` and `@phosphor-icons`
 * scopes and CSS, and allowlists the packages the graph does use.
 */
export const LOGIC_FORBIDDEN_PACKAGES = [
  'react-dom',
  'motion',
  'framer-motion',
  'shiki',
  'pdfjs-dist',
]

function isFile(path) {
  return existsSync(path) && statSync(path).isFile()
}

function resolveRelative(from, specifier) {
  const base = resolve(dirname(from), specifier)
  if (isFile(base)) return base
  for (const extension of EXTENSIONS) if (isFile(base + extension)) return base + extension
  for (const extension of EXTENSIONS) {
    const index = join(base, `index${extension}`)
    if (isFile(index)) return index
  }
  return null
}

function resolveSelf(specifier) {
  const exports = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')).exports
  const target = exports[`.${specifier.slice(PACKAGE_NAME.length)}`]
  return typeof target === 'string' ? join(packageDir, target) : null
}

function literalSource(node) {
  return node?.type === 'Literal' && typeof node.value === 'string' ? node.value : undefined
}

/** The specifier a node imports, if it is an import of any kind. */
function importedSpecifier(node, file) {
  switch (node.type) {
    case 'ImportDeclaration':
    case 'ExportAllDeclaration':
    case 'ExportNamedDeclaration':
      return literalSource(node.source)
    case 'TSImportType':
      // `import('./x').T`; older parsers name the literal `argument`.
      return literalSource(node.source) ?? literalSource(node.argument?.literal)
    case 'TSExternalModuleReference':
      return literalSource(node.expression)
    case 'ImportExpression':
    case 'CallExpression': {
      if (node.type === 'CallExpression' && node.callee?.name !== 'require') return undefined
      const source = node.type === 'ImportExpression' ? node.source : node.arguments[0]
      const specifier = literalSource(source)
      if (specifier === undefined) {
        throw new Error(`${file}: an import whose specifier is not a string cannot be followed`)
      }
      return specifier
    }
    default:
      return undefined
  }
}

/** Every specifier `file` imports, in source order. */
function importsOf(file) {
  const program = parse(readFileSync(file, 'utf8'), {
    sourceType: 'module',
    jsx: /\.[jt]sx$/.test(file),
    range: false,
    loc: false,
    comment: false,
  })
  const found = []
  const visit = (node) => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child)
      return
    }
    if (!node || typeof node !== 'object' || typeof node.type !== 'string') return
    const specifier = importedSpecifier(node, file)
    if (specifier !== undefined) found.push(specifier)
    for (const [key, value] of Object.entries(node)) {
      if (key !== 'parent' && value && typeof value === 'object') visit(value)
    }
  }
  visit(program)
  return found
}

/**
 * Walks every import (static, dynamic, `export … from`, type-only) from
 * `entry`, following relative and self-referencing specifiers. Returns each
 * file reached with the specifiers it names. An import that names a file that
 * is not there throws, so the graph can never quietly lose a branch.
 */
export function walkLogicGraph(entry = LOGIC_ENTRY) {
  const graph = new Map()
  const queue = [resolve(entry)]
  while (queue.length > 0) {
    const file = queue.pop()
    if (graph.has(file)) continue
    const specifiers = []
    graph.set(file, specifiers)
    if (!/\.(ts|tsx|mts|cts|js|jsx|mjs)$/.test(file)) continue
    for (const fileName of importsOf(file)) {
      specifiers.push(fileName)
      const local = fileName.startsWith('.')
      const self = fileName === PACKAGE_NAME || fileName.startsWith(`${PACKAGE_NAME}/`)
      if (!local && !self) continue
      const target = local ? resolveRelative(file, fileName) : resolveSelf(fileName)
      if (!target) throw new Error(`${file}: cannot resolve '${fileName}'`)
      queue.push(target)
    }
  }
  return graph
}

/** The graph's files, relative to `root` with forward slashes (ESLint's `files`). */
export function logicGraphFiles(root, entry = LOGIC_ENTRY) {
  return [...walkLogicGraph(entry).keys()]
    .map((file) => relative(root, file).split(sep).join('/'))
    .sort()
}
