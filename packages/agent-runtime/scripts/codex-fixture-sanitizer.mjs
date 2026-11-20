// The recorder's sanitiser, on its own so tests can import it.
//
// Kept apart from `record-codex-fixture.mjs`, which starts with a `#!` line:
// a test runner that wraps an imported module (vitest does) leaves that line
// somewhere it is a syntax error, and on Windows checkouts the CRLF ending
// stops it being stripped first.
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'

const REDACTED_KEYS = /^(email|userId|user_id|accountId|account_id|chatgptAccountId|chatgpt_account_id|chatgptUserId|chatgpt_user_id|organizationId|organization_id|orgId|workspaceId|workspace_id|installationId|installation_id)$/i
const SECRET_KEYS = /(token|secret|password|authorization|cookie|api_?key|encrypted)/i
const SECRET_VALUES = [
  [/eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, '<redacted-jwt>'],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, '<redacted-key>'],
  [/\b(?:ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{16,}/g, '<redacted-key>'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g, 'Bearer <redacted>'],
  // Not an address at all, so a committed fixture holds none (the leak check
  // and the fixture test refuse any).
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>'],
]

/** Home directories of any user, on macOS, Windows and Windows seen from WSL,
 * whoever recorded: the account name in them is not this process's user name
 * on WSL (`/mnt/c/Users/<WindowsName>`). The name runs to the next separator
 * or quote, spaces included (Windows allows them). Replaced with the home
 * placeholder, and refused by the leak check if anything survives.
 * JSON-escaped backslashes count as one. */
const FOREIGN_HOMES = [
  /\/mnt\/[a-z]\/Users\/[^/\\"'\n]+/gi,
  /(?<![A-Za-z0-9])\/Users\/[^/\\"'\n]+/g,
  /\b[A-Za-z]:(?:\\)+Users(?:\\)+[^/\\"'\n]+/gi,
]
const FOREIGN_HOME_LEAK = /\/Users\/|\b[A-Za-z]:(?:\\)+Users\b/i

/** A sanitiser for one recording: literal path and name replacements first
 * (longest first, so the workspace inside the home directory wins), then
 * account fields by key, then token-like values wherever they appear. */
export function makeSanitizer({ workspace, home, codexHome, user, host }) {
  const pairs = []
  const add = (from, to) => {
    if (!from || from.length < 3) return
    pairs.push([from, to])
    // JSON-escaped and Windows-style spellings of the same path.
    pairs.push([from.replaceAll('\\', '\\\\'), to])
  }
  for (const path of new Set([workspace, safeRealpath(workspace)])) add(path, '/workspace')
  if (codexHome) for (const path of new Set([codexHome, safeRealpath(codexHome)])) add(path, '/home/user/.codex')
  for (const path of new Set([home, safeRealpath(home)])) add(path, '/home/user')
  add(tmpdir(), '/tmp')
  pairs.sort((a, b) => b[0].length - a[0].length)

  // Any case, and bounded by anything but a letter or digit, so `Cletus`,
  // `cletus_dev` and `cletus-pc` all go (`\b` treats `_` as part of a word).
  // Too short to tell from ordinary text, or already the placeholder: left be.
  const named = (name, placeholder) =>
    name && name.length >= 3 && name.toLowerCase() !== placeholder
      ? new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(name)}(?![A-Za-z0-9])`, 'gi')
      : undefined
  const userPattern = named(user, 'user')
  const hostPattern = named(host, 'host')
  const text = (value) => {
    let out = value
    for (const [from, to] of pairs) out = out.split(from).join(to)
    for (const pattern of FOREIGN_HOMES) out = out.replace(pattern, '/home/user')
    for (const [pattern, to] of SECRET_VALUES) out = out.replace(pattern, to)
    if (hostPattern) out = out.replace(hostPattern, 'host')
    if (userPattern) out = out.replace(userPattern, 'user')
    return out
  }
  const walk = (value, key) => {
    if (typeof value === 'string') {
      if (key !== undefined && REDACTED_KEYS.test(key)) return `<${key}>`
      if (key !== undefined && SECRET_KEYS.test(key)) return '<redacted>'
      return text(value)
    }
    // An array's items are its key's values: `emails: [...]` is redacted too.
    if (Array.isArray(value)) return value.map((item) => walk(item, key))
    if (value && typeof value === 'object') {
      const out = {}
      for (const [k, v] of Object.entries(value)) out[text(k)] = walk(v, k)
      return out
    }
    return value
  }
  const homes = [home, safeRealpath(home)].filter((path) => path && path.length >= 3 && path !== '/home/user')
  return {
    entry: (entry) => walk(entry),
    /** Anything that survived sanitising and must not be committed. */
    leaks(serialised) {
      const lower = serialised.toLowerCase()
      const found = homes.filter((path) => lower.includes(path.toLowerCase()))
      const patterns = [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, FOREIGN_HOME_LEAK, userPattern, hostPattern]
      for (const pattern of patterns.filter(Boolean)) {
        pattern.lastIndex = 0
        const match = pattern.exec(serialised)
        if (match) found.push(match[0])
      }
      return found
    },
  }
}

function safeRealpath(path) {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
