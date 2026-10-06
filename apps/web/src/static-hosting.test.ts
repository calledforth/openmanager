import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// The hosted build is index.html plus public/ copied as is; Cloudflare Pages
// reads public/_headers. These pin what docs/web-deploy.md relies on.
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

function headerRules(text: string): Map<string, Map<string, string>> {
  const rules = new Map<string, Map<string, string>>()
  let current: Map<string, string> | undefined
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    if (!/^\s/.test(line)) {
      current = new Map()
      rules.set(line.trim(), current)
      continue
    }
    const trimmed = line.trim()
    const colon = trimmed.indexOf(':')
    if (trimmed.startsWith('!')) current?.set(trimmed, '')
    else current?.set(trimmed.slice(0, colon).toLowerCase(), trimmed.slice(colon + 1).trim())
  }
  return rules
}

function directives(policy: string): Map<string, string[]> {
  return new Map(
    policy
      .split(';')
      .map((part) => part.trim().split(/\s+/))
      .filter((parts) => parts[0])
      .map(([name, ...values]) => [name!, values]),
  )
}

const headersFile = read('../public/_headers')
const rules = headerRules(headersFile)
const everyPage = rules.get('/*')!
const csp = directives(everyPage.get('content-security-policy') ?? '')

describe('static hosting', () => {
  it('keeps index.html free of inline scripts, which the CSP refuses', () => {
    const scripts = read('../index.html').match(/<script\b[^>]*>/g) ?? []
    expect(scripts.length).toBeGreaterThan(0)
    for (const tag of scripts) expect(tag).toMatch(/\ssrc="/)
  })

  it('allows only same-origin scripts, plus WebAssembly for the highlighter', () => {
    expect(csp.get('script-src')).toEqual(["'self'", "'wasm-unsafe-eval'"])
    expect(csp.get('default-src')).toEqual(["'self'"])
    expect(csp.get('object-src')).toEqual(["'none'"])
    expect(csp.get('base-uri')).toEqual(["'none'"])
    expect(csp.get('frame-ancestors')).toEqual(["'none'"])
  })

  it('lets the page reach loopback environments and any https environment', () => {
    const connect = csp.get('connect-src') ?? []
    for (const source of [
      "'self'",
      'https:',
      'wss:',
      'http://127.0.0.1:*',
      'ws://127.0.0.1:*',
      'http://localhost:*',
      'ws://localhost:*',
    ]) {
      expect(connect).toContain(source)
    }
    // It would rewrite http://127.0.0.1 to https, which nothing serves.
    expect(csp.has('upgrade-insecure-requests')).toBe(false)
  })

  it('caches hashed assets for good and nothing else', () => {
    expect(rules.get('/assets/*')?.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(everyPage.has('cache-control')).toBe(false)
  })

  it('fits Cloudflare Pages limits', () => {
    expect(rules.size).toBeLessThanOrEqual(100)
    for (const line of headersFile.split(/\r?\n/)) expect(line.length).toBeLessThanOrEqual(2000)
  })
})
