// Re-pulls the Fluid Functionalism components into src/components/fluid from
// the published shadcn registry, rewriting its `@/` imports to relative paths.
//
//   node scripts/vendor-fluid.mjs
//
// Re-apply the local edits listed in src/components/fluid/README.md afterwards.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REGISTRY = 'https://www.fluidfunctionalism.com/r'
const DEST = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/components/fluid')

// Radix flavours. Registry dependencies are pulled in transitively.
const ITEMS = [
  'button',
  'tooltip',
  'dialog',
  'dropdown',
  'scroll-area',
  'tabs-subtle',
  'radio-group',
  'switch',
  'select',
  'combobox',
  'command-menu',
  'sidebar',
  'sidebar-inset-topbar',
  'sidebar-search-field',
  'sidebar-workspace-header',
  'sidebar-user-footer',
  'sidebar-app',
  'ask-user-questions',
  'thinking-indicator',
  'thinking-steps',
  'input-message',
  'chat-message',
  'input-group',
  'input-copy',
  'badge',
  'use-keyboard-nav-gate',
  'use-touch-primary',
]

const items = new Map()
async function collect(ref) {
  const url = ref.startsWith('http') ? ref : `${REGISTRY}/${ref}.json`
  const name = url.split('/r/')[1].replace(/\.json$/, '')
  if (items.has(name)) return
  items.set(name, null)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} → ${res.status}`)
  const item = await res.json()
  items.set(name, item)
  for (const dep of item.registryDependencies ?? []) await collect(dep)
}
for (const name of ITEMS) await collect(name)

function targetOf(item, file) {
  if (file.target) return file.target.replace(/^components\//, '')
  const base = path.posix.basename(file.path)
  if (item.type === 'registry:lib') return `lib/${base}`
  if (item.type === 'registry:hook' && file.path.includes('/hooks/')) return `hooks/${base}`
  return `ui/${base}`
}

function resolveAlias(spec) {
  let m
  if ((m = spec.match(/^@\/registry\/(?:default|radix)\/(.+)$/))) return `ui/${m[1]}`
  if ((m = spec.match(/^@\/components\/(.+)$/))) return m[1]
  if ((m = spec.match(/^@\/(lib|hooks)\/(.+)$/))) return `${m[1]}/${m[2]}`
  throw new Error(`Unmapped import ${spec}`)
}

let written = 0
for (const item of items.values()) {
  for (const file of item?.files ?? []) {
    const target = targetOf(item, file)
    if (target.startsWith('app/')) continue
    const content = file.content
      .replace(/(from\s+|import\s*\(\s*)(["'])(@\/[^"']+)\2/g, (_all, pre, quote, spec) => {
        let rel = path.posix.relative(path.posix.dirname(target), resolveAlias(spec))
        if (!rel.startsWith('.')) rel = `./${rel}`
        return `${pre}${quote}${rel}${quote}`
      })
      // The app imports Motion by its current name.
      .replace(/(["'])framer-motion\1/g, '$1motion/react$1')
    const dest = path.join(DEST, target)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, content)
    written += 1
  }
}
console.log(`Wrote ${written} files from ${items.size} registry items.`)
