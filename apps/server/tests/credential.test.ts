import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { loadClientToken, matchesClientToken } from '../src/credential.js'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'openmanager-token-test-'))
  directories.push(path)
  return path
}

it('atomically issues one private token shared by concurrent starts and restarts', async () => {
  const path = await directory()
  const tokens = await Promise.all(Array.from({ length: 8 }, () => loadClientToken(path)))
  expect(new Set(tokens).size).toBe(1)
  expect(tokens[0]).toMatch(/^[a-f0-9]{64}$/)
  expect(await loadClientToken(path)).toBe(tokens[0])
  expect(await readdir(path)).toEqual(['client-token'])
  if (process.platform !== 'win32')
    expect((await stat(join(path, 'client-token'))).mode & 0o777).toBe(0o600)
  expect(matchesClientToken(tokens[0], tokens[0])).toBe(true)
  expect(matchesClientToken(undefined, tokens[0])).toBe(false)
  expect(matchesClientToken('short', tokens[0])).toBe(false)
  expect(matchesClientToken('0'.repeat(64), '1'.repeat(64))).toBe(false)
})

it('fails closed on a corrupt credential without replacing it', async () => {
  const path = await directory()
  await writeFile(join(path, 'client-token'), 'invalid')
  await expect(loadClientToken(path)).rejects.toThrow('Invalid client-token')
  expect(await readFile(join(path, 'client-token'), 'utf8')).toBe('invalid')
})
