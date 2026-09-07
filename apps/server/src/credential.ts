import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { link, open, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'

const TOKEN_PATTERN = /^[a-f0-9]{64}$/
function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

/** An environment-wide development credential; pairing will replace issuance. */
export async function loadClientToken(dataDir: string): Promise<string> {
  const path = join(dataDir, 'client-token')
  const read = async () => {
    const token = (await readFile(path, 'utf8')).trim()
    if (!TOKEN_PATTERN.test(token))
      throw new Error('Invalid client-token file; restore it from backup.')
    return token
  }
  try {
    return await read()
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error
  }
  const temporaryPath = join(dataDir, `.client-token-${randomUUID()}.tmp`)
  const file = await open(temporaryPath, 'wx', 0o600)
  try {
    try {
      await file.writeFile(`${randomBytes(32).toString('hex')}\n`)
      await file.sync()
    } finally {
      await file.close()
    }
    try {
      await link(temporaryPath, path)
    } catch (error) {
      if (!hasCode(error, 'EEXIST')) throw error
    }
    if (process.platform !== 'win32') {
      const directory = await open(dataDir, 'r')
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
    }
    return await read()
  } finally {
    await unlink(temporaryPath)
  }
}

export function matchesClientToken(candidate: string | undefined, expected: string): boolean {
  return (
    candidate !== undefined &&
    TOKEN_PATTERN.test(candidate) &&
    timingSafeEqual(Buffer.from(candidate), Buffer.from(expected))
  )
}
