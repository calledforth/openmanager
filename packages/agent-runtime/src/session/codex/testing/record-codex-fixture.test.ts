import { describe, expect, it } from 'vitest'

/** The recorder's sanitiser (`scripts/codex-fixture-sanitizer.mjs`, used by
 * `record-codex-fixture.mjs`), which every committed fixture went through. A plain-Node script, so it is imported by
 * URL and typed here by hand. */
type Sanitizer = {
  entry: (entry: unknown) => unknown
  leaks: (serialised: string) => string[]
}
const script = new URL('../../../../scripts/codex-fixture-sanitizer.mjs', import.meta.url).href
const { makeSanitizer } = (await import(script)) as {
  makeSanitizer: (machine: { workspace: string; home: string; codexHome?: string; user: string; host: string }) => Sanitizer
}

const sanitizer = makeSanitizer({
  workspace: '/home/Ada_L/projects/demo',
  home: '/home/Ada_L',
  codexHome: '/home/Ada_L/.codex',
  user: 'Ada_L',
  host: 'Analytical-Engine',
})
const clean = (value: unknown) => JSON.stringify(sanitizer.entry(value))

describe('record-codex-fixture sanitiser', () => {
  it('replaces the workspace, the home directory and the user, whatever their case', () => {
    expect(clean({ cwd: '/home/Ada_L/projects/demo/src', note: 'built by ada_l for ADA_L-dev' })).toBe(
      JSON.stringify({ cwd: '/workspace/src', note: 'built by user for user-dev' }),
    )
  })

  it("replaces anyone's home on macOS, Windows and Windows under WSL", () => {
    expect(
      clean({
        mac: '/Users/ada/notes.txt',
        wsl: '/mnt/c/Users/Ada Lovelace/x',
        win: 'C:\\Users\\AdaL\\AppData',
      }),
    ).toBe(
      JSON.stringify({ mac: '/home/user/notes.txt', wsl: '/home/user/x', win: '/home/user\\AppData' }),
    )
  })

  it("replaces the machine's name", () => {
    expect(clean({ serverName: 'analytical-engine', banner: 'on Analytical-Engine.local' })).toBe(
      JSON.stringify({ serverName: 'host', banner: 'on host.local' }),
    )
  })

  it('redacts account fields by key, array items included, and every email', () => {
    expect(
      clean({
        workspaceId: 'ws-123',
        workspace_id: 'ws-123',
        email: ['ada@example.org', 'ada@analytical.co.uk'],
        text: 'mail ada@analytical.co.uk',
      }),
    ).toBe(
      JSON.stringify({
        workspaceId: '<workspaceId>',
        workspace_id: '<workspace_id>',
        email: ['<email>', '<email>'],
        text: 'mail <email>',
      }),
    )
  })

  it('refuses what survived: a home, the user or machine name in any case, any email', () => {
    expect(sanitizer.leaks('{"a":"/home/ada_l/x"}')).not.toEqual([])
    expect(sanitizer.leaks('{"a":"ADA_L"}')).toEqual(['ADA_L'])
    expect(sanitizer.leaks('{"a":"ANALYTICAL-ENGINE"}')).toEqual(['ANALYTICAL-ENGINE'])
    expect(sanitizer.leaks('{"a":"C:\\\\Users\\\\x"}')).not.toEqual([])
    expect(sanitizer.leaks('{"a":"/Users/x"}')).toEqual(['/Users/'])
    expect(sanitizer.leaks('{"a":"user@example.com"}')).toEqual(['user@example.com'])
    expect(sanitizer.leaks('{"a":"/home/user/.codex","b":"<email>"}')).toEqual([])
  })
})
