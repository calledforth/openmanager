import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadEnvironmentIdentity } from '../src/identity.js'

vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  hostname: vi.fn(() => 'Development laptop'),
}))

const execute = promisify(execFile)
const directories: string[] = []
async function dataDir() {
  const directory = await mkdtemp(join(tmpdir(), 'openmanager-identity-test-'))
  directories.push(directory)
  return directory
}
afterEach(async () => {
  vi.mocked(hostname).mockReturnValue('Development laptop')
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('environment identity', () => {
  it('persists a UUID and human label once and leaves the existing file untouched', async () => {
    const directory = await dataDir()
    const first = await loadEnvironmentIdentity(directory)
    expect(first.environmentId).toMatch(/^[0-9a-f-]{36}$/)
    expect(first.label).toBe(hostname().trim().slice(0, 128))
    const path = join(directory, 'identity.json')
    const original = await readFile(path, 'utf8')
    const before = await stat(path)
    vi.mocked(hostname).mockReturnValue('Renamed laptop')
    expect(await loadEnvironmentIdentity(directory)).toEqual(first)
    expect(await readFile(path, 'utf8')).toBe(original)
    expect((await stat(path)).mtimeMs).toBe(before.mtimeMs)
    if (process.platform !== 'win32') expect(before.mode & 0o777).toBe(0o600)
    expect(await readdir(directory)).toEqual(['identity.json'])
  })

  it.each(['  laptop\nname  ', 'x'.repeat(200), '\n\t'])(
    'normalizes the initial label (%j)',
    async (name) => {
      vi.mocked(hostname).mockReturnValue(name)
      const identity = await loadEnvironmentIdentity(await dataDir())
      expect(identity.label).toBe(
        name === '\n\t'
          ? `OpenManager ${identity.environmentId.slice(0, 8)}`
          : name.startsWith('x')
            ? 'x'.repeat(128)
            : 'laptopname',
      )
    },
  )

  it('converges on one identity across concurrent processes on first boot', async () => {
    const directory = await dataDir()
    const moduleUrl = new URL('../dist/identity.js', import.meta.url).href
    const program = `import { loadEnvironmentIdentity } from ${JSON.stringify(moduleUrl)};
      console.log(JSON.stringify(await loadEnvironmentIdentity(process.argv[1])));`
    const outputs = await Promise.all(
      Array.from({ length: 6 }, () =>
        execute(process.execPath, ['--input-type=module', '-e', program, directory], {
          windowsHide: true,
        }),
      ),
    )
    const identities = outputs.map(({ stdout }) => JSON.parse(stdout))
    for (const identity of identities) expect(identity).toEqual(identities[0])
    expect(await loadEnvironmentIdentity(directory)).toEqual(identities[0])
    expect(await readdir(directory)).toEqual(['identity.json'])
  })

  it.each([
    '',
    '{',
    'null',
    JSON.stringify({ version: 2, environmentId: 'not-a-uuid', label: 'Future' }),
    JSON.stringify({ version: 1, environmentId: 'not-a-uuid', label: 'Broken' }),
    JSON.stringify({
      version: 1,
      environmentId: 'efdfcb92-773a-4d19-a7cd-6cf9b8e76a16',
      label: '',
    }),
  ])(
    'fails closed for invalid existing data (%j), preserving it for recovery',
    async (contents) => {
      const directory = await dataDir()
      const path = join(directory, 'identity.json')
      await writeFile(path, contents)
      await expect(loadEnvironmentIdentity(directory)).rejects.toThrow('identity is invalid')
      expect(await readFile(path, 'utf8')).toBe(contents)
      expect(await readdir(directory)).toEqual(['identity.json'])
    },
  )

  it('reuses the saved label and does not derive identity from directory location', async () => {
    const directory = await dataDir()
    const saved = { ...(await loadEnvironmentIdentity(directory)), label: 'Development machine' }
    const relocated = await dataDir()
    await writeFile(join(relocated, 'identity.json'), JSON.stringify(saved))
    expect(await loadEnvironmentIdentity(relocated)).toEqual(saved)
  })

  it('creates a new identity after a deliberate data-directory reset', async () => {
    const directory = await dataDir()
    const before = await loadEnvironmentIdentity(directory)
    await rm(directory, { recursive: true })
    const after = await loadEnvironmentIdentity(directory)
    expect(after.environmentId).not.toBe(before.environmentId)
  })

  it('gives separate environments on the same device distinct IDs', async () => {
    const first = await loadEnvironmentIdentity(await dataDir())
    const second = await loadEnvironmentIdentity(await dataDir())
    expect(first.environmentId).not.toBe(second.environmentId)
    expect(first.label).toBe(second.label)
  })

  it('ignores an interrupted unpublished temporary record', async () => {
    const directory = await dataDir()
    const temporary = join(directory, '.identity-interrupted.tmp')
    await writeFile(temporary, '{')
    const identity = await loadEnvironmentIdentity(directory)
    expect(await loadEnvironmentIdentity(directory)).toEqual(identity)
    expect(await readFile(temporary, 'utf8')).toBe('{')
  })
})
