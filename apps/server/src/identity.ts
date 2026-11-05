import { randomUUID } from 'node:crypto'
import { link, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'

const IdentitySchema = z.strictObject({
  version: z.literal(1),
  environmentId: z.uuid(),
  label: z
    .string()
    .min(1)
    .max(128)
    .refine(
      (label) =>
        label.trim().length > 0 &&
        [...label].every((character) => {
          const code = character.codePointAt(0)!
          return code >= 32 && code !== 127
        }),
    ),
})

export type EnvironmentIdentity = Readonly<z.infer<typeof IdentitySchema>>

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

async function readIdentity(path: string): Promise<EnvironmentIdentity> {
  const contents = await readFile(path, 'utf8')
  try {
    return Object.freeze(IdentitySchema.parse(JSON.parse(contents)))
  } catch (cause) {
    throw new Error(
      'Environment identity is invalid; restore identity.json from backup instead of regenerating it.',
      { cause },
    )
  }
}

/** Publish a fully written record once, without overwriting another starter's ID. */
export async function loadEnvironmentIdentity(dataDir: string): Promise<EnvironmentIdentity> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 })
  const path = join(dataDir, 'identity.json')
  try {
    return await readIdentity(path)
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error
  }

  const environmentId = randomUUID()
  const deviceName = [...hostname()]
    .filter((character) => {
      const code = character.codePointAt(0)!
      return code >= 32 && code !== 127
    })
    .join('')
    .trim()
    .slice(0, 128)
  const identity = IdentitySchema.parse({
    version: 1,
    environmentId,
    label: deviceName || `OpenManager ${environmentId.slice(0, 8)}`,
  })
  const temporaryPath = join(dataDir, `.identity-${randomUUID()}.tmp`)
  const file = await open(temporaryPath, 'wx', 0o600)
  try {
    try {
      await file.writeFile(`${JSON.stringify(identity, null, 2)}\n`, 'utf8')
      await file.sync()
    } finally {
      await file.close()
    }
    try {
      // A hard link is atomic and fails with EEXIST if another process won.
      // rename() would overwrite that process's already-published identity.
      await link(temporaryPath, path)
    } catch (error) {
      if (!hasCode(error, 'EEXIST')) throw error
    }
    // Windows does not support opening directories for fsync through Node.
    if (process.platform !== 'win32') {
      const directory = await open(dataDir, 'r')
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
    }
    return await readIdentity(path)
  } finally {
    await unlink(temporaryPath)
  }
}

/**
 * Give the environment a new name, keeping its ID. The record is written whole
 * to a temporary file and moved over the old one, so a crash leaves either
 * name, never half of one. Returns the record now on disk; a failure before
 * the move leaves the old name in place and rejects.
 */
export async function renameEnvironmentIdentity(
  dataDir: string,
  current: EnvironmentIdentity,
  label: string,
): Promise<EnvironmentIdentity> {
  const identity = IdentitySchema.parse({ ...current, label })
  const path = join(dataDir, 'identity.json')
  const temporaryPath = join(dataDir, `.identity-${randomUUID()}.tmp`)
  const file = await open(temporaryPath, 'wx', 0o600)
  try {
    try {
      await file.writeFile(`${JSON.stringify(identity, null, 2)}\n`, 'utf8')
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(temporaryPath, path)
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined)
    throw error
  }
  // From here the new name is on disk, so it is the answer whatever follows:
  // failing now would leave the file and the running server disagreeing.
  if (process.platform !== 'win32') {
    try {
      const directory = await open(dataDir, 'r')
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
    } catch {
      // Durability of the move only; the file already reads the new name.
    }
  }
  return Object.freeze(identity)
}
