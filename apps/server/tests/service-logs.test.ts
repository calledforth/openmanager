import { mkdtemp, writeFile, appendFile, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseLogOptions, tailLogFile } from '../src/service/logs.ts'

const directories: string[] = []
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'service-logs-'))
  directories.push(dir)
  return join(dir, 'server.log')
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('service log tail', () => {
  it.each([['--lines'], ['--lines', '1.5'], ['--lines', '10001'], ['--bad']])(
    'rejects %j',
    (...args) => {
      expect(() => parseLogOptions(args)).toThrow()
    },
  )

  it('prints only the requested last lines, including an unfinished UTF-8 line', async () => {
    const path = await fixture()
    await writeFile(path, 'one\r\ntwo\r\n三')
    const output: string[] = []
    await tailLogFile(path, { lines: 2, follow: false }, (text) => output.push(text))
    expect(output).toEqual(['two', '三'])
    output.length = 0
    await tailLogFile(path, { lines: 0, follow: false }, (text) => output.push(text))
    expect(output).toEqual([])
  })

  it('bounds the initial read of a large log', async () => {
    const path = await fixture()
    await writeFile(path, `${'old\n'.repeat(400000)}recent\n`)
    const output: string[] = []
    await tailLogFile(path, { lines: 1, follow: false }, (text) => output.push(text))
    expect(output).toEqual(['recent'])
  })

  it('explains missing logs', async () => {
    await expect(
      tailLogFile(await fixture(), { lines: 100, follow: false }, () => {}),
    ).rejects.toThrow('does not exist yet')
  })

  it('follows appends, split UTF-8, rotation and truncation, then cancels cleanly', async () => {
    const path = await fixture()
    await writeFile(path, 'initial\n')
    const output: string[] = []
    const controller = new AbortController()
    const follow = tailLogFile(
      path,
      { lines: 1, follow: true },
      (text) => output.push(text),
      controller.signal,
    )
    try {
      await expect.poll(() => output).toContain('initial')
      const bytes = Buffer.from('三\n')
      await appendFile(path, bytes.subarray(0, 1))
      await new Promise((resolve) => setTimeout(resolve, 350))
      await appendFile(path, bytes.subarray(1))
      await expect.poll(() => output).toContain('三')
      await rename(path, `${path}.1`)
      await writeFile(path, 'rotated and longer\n')
      await expect.poll(() => output).toContain('rotated and longer')
      await writeFile(path, 'short\n')
      await expect.poll(() => output).toContain('short')
    } finally {
      controller.abort()
      await follow
    }
    expect(output).toEqual(['initial', '三', 'rotated and longer', 'short'])
  })

  it('waits for a missing log in follow mode', async () => {
    const path = await fixture()
    const controller = new AbortController()
    const output: string[] = []
    const follow = tailLogFile(
      path,
      { lines: 100, follow: true },
      (text) => output.push(text),
      controller.signal,
    )
    try {
      await writeFile(path, 'created\n')
      await expect.poll(() => output).toContain('created')
    } finally {
      controller.abort()
      await follow
    }
  })
})
