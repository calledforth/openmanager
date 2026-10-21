// Generates src/lib/theme-tokens.generated.ts: every custom property each
// `data-theme` scheme resolves to, with the CSS colour maths done, so a client
// that has no CSS engine (React Native) paints the same colours web does.
//
//   node scripts/theme-tokens.mjs            # write the file
//   node scripts/theme-tokens.mjs --check    # exit 1 if it is out of date
//
// The source of truth stays styles/globals.css and styles/fluid.css. This
// script applies the cascade the way the browser does for one scheme on the
// root element: every top-level `:root` / `html` rule, plus the rules whose
// `[data-theme=…]` matches, by specificity then source order (fluid.css first,
// since globals.css imports it before its own root rules). Rules on descendants, pseudo-elements, media
// queries and Tailwind's `@theme` / `@utility` blocks are not part of the root
// cascade and are skipped. `var()` references are substituted and `color-mix`,
// `oklch`, `rgb` and friends are evaluated with culori, so a value comes out as
// `#rrggbb`, `rgba(r, g, b, a)`, or the original text for anything that is not
// a colour (sizes, shadows, gradients). Shadows are also parsed into layers.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import postcss from 'postcss'
import { converter, interpolateWithPremultipliedAlpha, parse as parseColor } from 'culori'

const toRgb = converter('rgb')

const here = path.dirname(fileURLToPath(import.meta.url))
const stylesDir = path.join(here, '../src/styles')
const OUTPUT = path.join(here, '../src/lib/theme-tokens.generated.ts')

/**
 * Cascade order: globals.css imports fluid.css (line 92) before its own
 * `:root` rules, so fluid.css declarations come first in source order.
 */
const SOURCES = ['fluid.css', 'globals.css']

/** The UI font the phone uses; `[data-ui-font=…]` rules for others are skipped. */
const UI_FONT = 'geist'

/** Every scheme, as theme-families.ts lists them. `dark` is the bare root. */
export const SCHEMES = [
  'light',
  'dark',
  'neutral-light',
  'neutral',
  'paper-light',
  'paper',
  'lovable-light',
  'lovable',
  'claude-light',
  'claudeish',
  'carbon-light',
  'carbon',
]

/** Shadow tokens get a parsed form next to the text. */
const SHADOW_PREFIXES = ['--float-shadow', '--shadow-']

// ─── Selector matching ──────────────────────────────────────────────────────

/** Split on commas that are not inside parentheses or brackets. */
function splitTopLevel(text, separator = ',') {
  const parts = []
  let depth = 0
  let current = ''
  for (const ch of text) {
    if (ch === '(' || ch === '[') depth++
    else if (ch === ')' || ch === ']') depth--
    if (ch === separator && depth === 0) {
      parts.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  parts.push(current)
  return parts.map((part) => part.trim()).filter(Boolean)
}

const THEME_ATTR = /\[data-theme=['"]?([a-z-]+)['"]?\]/g
const FONT_ATTR = /\[data-ui-font=['"]?([a-z-]+)['"]?\]/g

/**
 * Whether one compound selector targets the root element for `scheme`. The
 * root is `:root` or `html`, optionally qualified by `[data-theme=…]`,
 * `:is([data-theme=…], …)`, `[data-ui-font=…]` or `:not([data-ui-font])`.
 * Anything with a descendant, a class, a pseudo-element or another attribute
 * is not the root cascade and does not match.
 */
function matchesRoot(selector, scheme) {
  let rest = selector.trim()
  if (rest.startsWith(':root')) rest = rest.slice(5)
  else if (rest.startsWith('html')) rest = rest.slice(4)
  else return false
  if (rest === '') return true
  // :is(…) groups: match if any member names the scheme.
  rest = rest.replace(/:is\(([^)]*)\)/g, (_, inner) => {
    const themes = [...inner.matchAll(THEME_ATTR)].map((m) => m[1])
    if (themes.length === 0) return '\u0000no'
    return themes.includes(scheme) ? '' : '\u0000no'
  })
  if (rest.includes('\u0000no')) return false
  rest = rest.replace(THEME_ATTR, (_, theme) => (theme === scheme ? '' : '\u0000no'))
  if (rest.includes('\u0000no')) return false
  if (scheme === 'dark' && selector.includes('data-theme')) return false
  rest = rest.replace(FONT_ATTR, (_, font) => (font === UI_FONT ? '' : '\u0000no'))
  if (rest.includes('\u0000no')) return false
  rest = rest.replace(/:not\(\[data-ui-font\]\)/g, '')
  return rest.trim() === ''
}

/**
 * Specificity of a root selector as one number: `:root`, each attribute,
 * `:not(…)` and `:is(…)` (its one attribute) count 10; `html` counts 1.
 */
function specificity(selector) {
  let score = 0
  if (selector.trim().startsWith(':root')) score += 10
  else if (selector.trim().startsWith('html')) score += 1
  score += 10 * (selector.match(/\[data-[a-z-]+=/g) ?? []).length
  score += 10 * (selector.match(/:not\(/g) ?? []).length
  // :is() contributes its most specific argument, one attribute, not one per member.
  for (const group of selector.matchAll(/:is\(([^)]*)\)/g)) {
    score -= 10 * ((group[1].match(/\[data-[a-z-]+=/g) ?? []).length - 1)
  }
  return score
}

/** The highest specificity among the rule's selectors that match the scheme, or -1. */
function ruleSpecificity(rule, scheme) {
  let best = -1
  for (const selector of splitTopLevel(rule.selector)) {
    if (matchesRoot(selector, scheme)) best = Math.max(best, specificity(selector))
  }
  return best
}

/** Rules under `@layer` are part of the cascade; other at-rules are not. */
function inRootCascade(rule) {
  let node = rule.parent
  while (node && node.type !== 'root') {
    if (node.type !== 'atrule' || node.name !== 'layer') return false
    node = node.parent
  }
  return true
}

// ─── Value resolution ────────────────────────────────────────────────────────

/** Find `name(` … matching `)` starting at `from`; returns [start, end) or null. */
function findCall(text, name, from = 0) {
  const start = text.indexOf(`${name}(`, from)
  if (start === -1) return null
  let depth = 0
  for (let i = start + name.length; i < text.length; i++) {
    if (text[i] === '(') depth++
    else if (text[i] === ')') {
      depth--
      if (depth === 0) return [start, i + 1]
    }
  }
  throw new Error(`Unbalanced ${name}( in: ${text}`)
}

/** Substitute every var(--x[, fallback]) with the declared value, recursively. */
function substituteVars(value, declared, stack) {
  let out = value
  for (;;) {
    const span = findCall(out, 'var')
    if (!span) return out
    const [start, end] = span
    const inner = out.slice(start + 4, end - 1)
    const [name, ...fallbackParts] = splitTopLevel(inner)
    const fallback = fallbackParts.join(', ')
    if (stack.includes(name)) throw new Error(`Cycle through ${stack.join(' -> ')} -> ${name}`)
    let replacement
    if (declared.has(name)) {
      replacement = substituteVars(declared.get(name), declared, [...stack, name])
    } else if (fallbackParts.length > 0) {
      replacement = substituteVars(fallback, declared, stack)
    } else {
      // Undefined with no fallback: the browser treats the whole declaration
      // as invalid at computed-value time. Keep it visible so the generated
      // file never silently carries a dead reference.
      throw new Error(`Undefined ${name} (via ${stack.join(' -> ') || 'root'})`)
    }
    out = out.slice(0, start) + replacement + out.slice(end)
  }
}

/** A colour object to the text form the generated file uses. */
function colorText(color) {
  const rgb = toRgb(color)
  const alpha = color.alpha ?? 1
  const c = (v) => Math.max(0, Math.min(255, Math.round(v * 255)))
  if (alpha >= 1) {
    return `#${[rgb.r, rgb.g, rgb.b].map((v) => c(v).toString(16).padStart(2, '0')).join('')}`
  }
  return `rgba(${c(rgb.r)}, ${c(rgb.g)}, ${c(rgb.b)}, ${Number(alpha.toFixed(4))})`
}

/** Parse one colour expression that culori understands, or null. */
function parseOne(text) {
  const trimmed = text.trim()
  if (trimmed === 'transparent') return { mode: 'rgb', r: 0, g: 0, b: 0, alpha: 0 }
  const color = parseColor(trimmed)
  return color ?? null
}

/**
 * color-mix(in <space>, <a> [p%], <b> [q%]) per CSS Color 5: a missing
 * percentage is 100 minus the other; both missing is 50/50. Interpolated in
 * the named space (oklab, oklch, srgb) with premultiplied alpha, as the spec
 * says, so mixing a colour with `transparent` keeps its hue and only fades.
 */
function evalColorMix(inner) {
  const [spaceSpec, first, second] = splitTopLevel(inner)
  const space = spaceSpec.replace(/^in\s+/, '').trim()
  const mode = { srgb: 'rgb', oklab: 'oklab', oklch: 'oklch', hsl: 'hsl', lab: 'lab', lch: 'lch' }[
    space
  ]
  if (!mode) throw new Error(`Unsupported color-mix space: ${space}`)
  const read = (part) => {
    const m = part.trim().match(/^(.*?)(?:\s+([\d.]+)%)?$/s)
    const color = parseOne(m[1])
    if (!color) throw new Error(`color-mix: cannot parse "${m[1]}"`)
    return { color, pct: m[2] === undefined ? null : Number(m[2]) }
  }
  const a = read(first)
  const b = read(second)
  let pa = a.pct
  let pb = b.pct
  if (pa === null && pb === null) {
    pa = pb = 50
  } else if (pa === null) pa = 100 - pb
  else if (pb === null) pb = 100 - pa
  const total = pa + pb
  const t = pb / total
  const mixed = interpolateWithPremultipliedAlpha([a.color, b.color], mode)(t)
  if (total < 100) mixed.alpha = (mixed.alpha ?? 1) * (total / 100)
  return mixed
}

/** Evaluate every colour function in a value, innermost first, to #hex / rgba(). */
function evalColors(value) {
  let out = value
  // color-mix may nest colour functions; evaluate the innermost first by
  // repeatedly finding the last-opening occurrence.
  for (;;) {
    let span = null
    let from = 0
    for (;;) {
      const next = findCall(out, 'color-mix', from)
      if (!next) break
      span = next
      from = next[0] + 1
    }
    if (!span) break
    const mixed = evalColorMix(out.slice(span[0] + 'color-mix('.length, span[1] - 1))
    out = out.slice(0, span[0]) + colorText(mixed) + out.slice(span[1])
  }
  for (const fn of ['oklch', 'oklab', 'rgb', 'rgba', 'hsl', 'hsla', 'lab', 'lch']) {
    // Walk forward: a normalised colour is itself `rgba(…)`, so searching from
    // the start again would find the replacement and never finish.
    let from = 0
    for (;;) {
      const span = findCall(out, fn, from)
      if (!span) break
      // `rgb(var(--overlay) / 0.08)` has had var() substituted already.
      const color = parseOne(out.slice(span[0], span[1]))
      if (!color) throw new Error(`Cannot parse colour: ${out.slice(span[0], span[1])}`)
      const text = colorText(color)
      out = out.slice(0, span[0]) + text + out.slice(span[1])
      from = span[0] + text.length
    }
  }
  // Bare hex and named colours on their own.
  const whole = parseOne(out)
  if (whole && /^(#[0-9a-f]{3,8}|[a-z]+)$/i.test(out.trim())) return colorText(whole)
  return out.replace(/\s+/g, ' ').trim()
}

// ─── Shadows ────────────────────────────────────────────────────────────────

const LENGTH = /^-?[\d.]+px$/

/** `inset? x y blur? spread? color` layers, comma separated. */
function parseShadow(text) {
  return splitTopLevel(text).map((layer) => {
    const parts = splitTopLevel(layer, ' ')
    const out = { inset: false, x: 0, y: 0, blur: 0, spread: 0, color: '#000000' }
    const lengths = []
    for (const part of parts) {
      if (part === 'inset') out.inset = true
      else if (LENGTH.test(part)) lengths.push(Number(part.slice(0, -2)))
      else if (part === '0') lengths.push(0)
      else out.color = part
    }
    ;[out.x = 0, out.y = 0, out.blur = 0, out.spread = 0] = lengths
    return out
  })
}

// ─── Generation ─────────────────────────────────────────────────────────────

function readCascade() {
  const rules = []
  for (const file of SOURCES) {
    const css = fs.readFileSync(path.join(stylesDir, file), 'utf8')
    const root = postcss.parse(css, { from: file })
    // Tailwind emits every `@theme` variable as a `:root` custom property, so
    // the block joins the cascade as a root rule where it appears.
    root.walkAtRules('theme', (atRule) => {
      const decls = []
      atRule.each((node) => {
        if (node.type === 'decl' && node.prop.startsWith('--')) decls.push([node.prop, node.value])
      })
      if (decls.length > 0) rules.push({ selector: ':root', decls })
    })
    root.walkRules((rule) => {
      if (!inRootCascade(rule)) return
      const decls = []
      rule.each((node) => {
        if (node.type === 'decl' && node.prop.startsWith('--')) decls.push([node.prop, node.value])
      })
      if (decls.length > 0) rules.push({ selector: rule.selector, decls })
    })
  }
  return rules
}

export function generateThemeTokens() {
  const rules = readCascade()
  const perScheme = new Map()
  for (const scheme of SCHEMES) {
    // Later wins among equal specificity; higher specificity wins otherwise.
    const winning = new Map()
    for (const rule of rules) {
      const spec = ruleSpecificity(rule, scheme)
      if (spec < 0) continue
      for (const [prop, value] of rule.decls) {
        const current = winning.get(prop)
        if (!current || spec >= current.spec) winning.set(prop, { value, spec })
      }
    }
    const declared = new Map([...winning].map(([prop, { value }]) => [prop, value]))
    const tokens = new Map()
    for (const [prop, raw] of declared) {
      let resolved
      try {
        resolved = evalColors(substituteVars(raw, declared, [prop]))
      } catch (error) {
        throw new Error(`${scheme} ${prop}: ${error.message}`)
      }
      tokens.set(prop.slice(2), resolved)
    }
    perScheme.set(scheme, tokens)
  }
  return perScheme
}

function render(perScheme) {
  const names = new Map() // name -> number of schemes defining it
  for (const tokens of perScheme.values()) {
    for (const name of tokens.keys()) names.set(name, (names.get(name) ?? 0) + 1)
  }
  const everywhere = [...names].filter(([, n]) => n === perScheme.size).map(([name]) => name)
  const partial = [...names].filter(([, n]) => n !== perScheme.size).map(([name]) => name)
  everywhere.sort()
  partial.sort()
  const shadowNames = everywhere.filter((name) =>
    SHADOW_PREFIXES.some((prefix) => `--${name}`.startsWith(prefix)),
  )

  const q = (s) => JSON.stringify(s)
  const lines = []
  lines.push(
    '// Generated by scripts/theme-tokens.mjs from styles/globals.css and',
    '// styles/fluid.css. Do not edit; run `pnpm --filter @openmanager/app-core',
    '// theme-tokens` after changing a token. tests/theme-tokens.test.ts fails',
    '// when this file is stale.',
    '',
    "import type { ThemeMode } from './theme-families'",
    '',
    '/** A custom property every scheme defines, without the leading `--`. */',
    'export type ThemeTokenName =',
    ...everywhere.map((name) => `  | ${q(name)}`),
    '',
    '/** A custom property only some schemes define. */',
    'export type OptionalThemeTokenName =',
    ...(partial.length ? partial.map((name) => `  | ${q(name)}`) : ['  | never']),
    '',
    'export type ThemeTokens = Record<ThemeTokenName, string> &',
    '  Partial<Record<OptionalThemeTokenName, string>>',
    '',
    '/** One layer of a CSS box-shadow, lengths in px. */',
    'export interface ShadowLayer {',
    '  inset: boolean',
    '  x: number',
    '  y: number',
    '  blur: number',
    '  spread: number',
    '  color: string',
    '}',
    '',
    'export type ShadowTokenName =',
    ...shadowNames.map((name) => `  | ${q(name)}`),
    '',
    '/** Every custom property each scheme resolves to on the root element. */',
    'export const THEME_TOKENS: Record<ThemeMode, ThemeTokens> = {',
  )
  for (const [scheme, tokens] of perScheme) {
    lines.push(`  ${q(scheme)}: {`)
    for (const name of [...tokens.keys()].sort()) {
      lines.push(`    ${q(name)}: ${q(tokens.get(name))},`)
    }
    lines.push('  },')
  }
  lines.push('}', '', '/** The shadow tokens, parsed into layers. */')
  lines.push(
    'export const THEME_SHADOWS: Record<ThemeMode, Record<ShadowTokenName, ShadowLayer[]>> = {',
  )
  for (const [scheme, tokens] of perScheme) {
    lines.push(`  ${q(scheme)}: {`)
    for (const name of shadowNames) {
      const layers = parseShadow(tokens.get(name))
      lines.push(`    ${q(name)}: [`)
      for (const layer of layers) {
        lines.push(
          `      { inset: ${layer.inset}, x: ${layer.x}, y: ${layer.y}, blur: ${layer.blur}, spread: ${layer.spread}, color: ${q(layer.color)} },`,
        )
      }
      lines.push('    ],')
    }
    lines.push('  },')
  }
  lines.push('}', '')
  return lines.join('\n')
}

export function renderThemeTokens() {
  return render(generateThemeTokens())
}

export function currentThemeTokensFile() {
  return fs.existsSync(OUTPUT) ? fs.readFileSync(OUTPUT, 'utf8') : ''
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const text = renderThemeTokens()
  if (process.argv.includes('--check')) {
    if (text !== currentThemeTokensFile()) {
      console.error(`${path.relative(process.cwd(), OUTPUT)} is out of date; run the generator.`)
      process.exit(1)
    }
    console.log('theme tokens up to date')
  } else {
    fs.writeFileSync(OUTPUT, text)
    console.log(`wrote ${path.relative(process.cwd(), OUTPUT)}`)
  }
}
