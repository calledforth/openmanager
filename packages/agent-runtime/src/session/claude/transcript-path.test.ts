import { mkdir, mkdtemp, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { findClaudeTranscript } from './transcript-path.js'

describe('findClaudeTranscript', () => {
  it('finds a session transcript in any project, the newest when there are several', async () => {
    const config = await mkdtemp(join(tmpdir(), 'claude-config-'))
    const id = '9deacf7a-a296-4dea-a8fe-d70788bd5ea6'
    for (const project of ['-tmp-a', '-tmp-b', '-tmp-c']) {
      await mkdir(join(config, 'projects', project), { recursive: true })
    }
    const older = join(config, 'projects', '-tmp-a', `${id}.jsonl`)
    const newer = join(config, 'projects', '-tmp-b', `${id}.jsonl`)
    await writeFile(older, '{}\n')
    await writeFile(newer, '{}\n')
    await utimes(older, new Date(1_000_000), new Date(1_000_000))
    const env = { CLAUDE_CONFIG_DIR: config }

    expect(await findClaudeTranscript(id, env)).toBe(newer)
    expect(await findClaudeTranscript('00000000-0000-0000-0000-000000000000', env)).toBeUndefined()
    // Never a path built from something that is not an id.
    expect(await findClaudeTranscript('../../etc/passwd', env)).toBeUndefined()
  })

  it('answers undefined when there is no projects folder', async () => {
    const config = await mkdtemp(join(tmpdir(), 'claude-config-'))
    expect(await findClaudeTranscript('abc', { CLAUDE_CONFIG_DIR: config })).toBeUndefined()
  })
})
