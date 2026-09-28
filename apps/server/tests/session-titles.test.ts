import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CliRequest } from '../src/session-titles/cli.js'
import { CliError, needsShell, runCli, shellArgument } from '../src/session-titles/cli.js'
import { formatTitleContext } from '../src/session-titles/context.js'
import { createTitleGenerator, TitleGenerationError } from '../src/session-titles/generator.js'
import {
  buildTitlePrompt,
  EARLIER_CONTENT_OMITTED,
  MAX_GENERATED_TITLE_LENGTH,
  parseGeneratedTitle,
} from '../src/session-titles/prompts.js'

describe('title prompts', () => {
  it('asks for a first title from the prompt alone', () => {
    const prompt = buildTitlePrompt({ message: 'fix the login redirect', attachments: ['a.png'] })
    expect(prompt).toContain('Set needsRefinement to true only if')
    expect(prompt).toContain('User message:\nfix the login redirect')
    expect(prompt).toContain('Attached files:\n- a.png')
  })

  it('asks for a new title against the previous one', () => {
    const prompt = buildTitlePrompt({ message: 'USER:\nfix it', previousTitle: 'Fix It' })
    expect(prompt).toContain('The previous title was "Fix It".')
    expect(prompt).toContain('Session contents:\nUSER:\nfix it')
  })

  it('keeps the newest end of a long conversation', () => {
    const message = `${'a'.repeat(9_000)}END`
    const prompt = buildTitlePrompt({ message, previousTitle: 'x' })
    expect(prompt).toContain(`${EARLIER_CONTENT_OMITTED}${'a'.repeat(7_997)}END`)
  })

  it('reads a title from schema output, prose, or a code fence', () => {
    expect(parseGeneratedTitle({ title: 'Fix Login', needsRefinement: true })).toEqual({
      title: 'Fix Login',
      needsRefinement: true,
    })
    expect(
      parseGeneratedTitle('Sure! ```json\n{"title": "Fix {Login}", "needsRefinement": false}\n```'),
    ).toEqual({ title: 'Fix {Login}', needsRefinement: false })
    expect(parseGeneratedTitle('{"note": 1} then {"title": "\\"Quoted\\""}')).toEqual({
      title: 'Quoted',
      needsRefinement: false,
    })
    expect(parseGeneratedTitle('no json here')).toBeUndefined()
    expect(parseGeneratedTitle({ title: '   ' })).toBeUndefined()
  })

  it('cuts a long title to one row', () => {
    const parsed = parseGeneratedTitle({ title: `${'word '.repeat(30)}\nsecond line` })
    expect(Array.from(parsed!.title)).toHaveLength(MAX_GENERATED_TITLE_LENGTH)
    expect(parsed!.title.endsWith('...')).toBe(true)
    expect(parsed!.title).not.toContain('second')
  })
})

describe('title context', () => {
  it('lays a short conversation out whole, in order', () => {
    expect(
      formatTitleContext([
        { role: 'user', text: 'fix this' },
        { role: 'assistant', text: 'The retry loop never backs off.' },
      ]),
    ).toEqual({
      message: 'USER:\nfix this\n\nASSISTANT:\nThe retry loop never backs off.',
      attachments: [],
    })
  })

  it('never lets assistant output push out what the user asked', () => {
    const { message } = formatTitleContext([
      { role: 'user', text: 'FIRST ask' },
      ...Array.from({ length: 20 }, () => ({
        role: 'assistant' as const,
        text: 'x'.repeat(3_000),
      })),
      { role: 'user', text: 'LATEST ask' },
    ])
    expect(message.startsWith(EARLIER_CONTENT_OMITTED)).toBe(true)
    expect(message).toContain('USER:\nFIRST ask')
    expect(message).toContain('USER:\nLATEST ask')
    expect(message.length).toBeLessThanOrEqual(8_000)
  })

  it('keeps the first attachment and the most recent ones', () => {
    const { attachments } = formatTitleContext([
      { role: 'user', text: 'look', attachments: ['first.png'] },
      ...['b', 'c', 'd', 'e'].map((name) => ({
        role: 'user' as const,
        text: name,
        attachments: [`${name}.png`],
      })),
    ])
    expect(attachments).toEqual(['first.png', 'c.png', 'd.png', 'e.png'])
  })
})

describe('shell arguments', () => {
  it('knows which commands need a shell', () => {
    expect(needsShell('C:\\bin\\claude.exe', 'win32')).toBe(false)
    expect(needsShell('codex', 'win32')).toBe(true)
    expect(needsShell('codex', 'linux')).toBe(false)
  })

  it('quotes what cmd.exe would split and refuses quotes', () => {
    expect(shellArgument('')).toBe('""')
    expect(shellArgument('plain')).toBe('plain')
    expect(shellArgument('C:\\Temp Dir\\x')).toBe('"C:\\Temp Dir\\x"')
    expect(shellArgument('model_reasoning_effort=low')).toBe('"model_reasoning_effort=low"')
    expect(() => shellArgument('{"a":1}')).toThrow()
  })
})

describe('title generator', () => {
  const env = { PATH: '', CLAUDE_CODE_BIN: process.execPath }

  function recordingRunner(answer: (request: CliRequest) => Promise<string> | string) {
    const requests: CliRequest[] = []
    return {
      requests,
      run: async (request: CliRequest) => {
        requests.push(request)
        return answer(request)
      },
    }
  }

  it('refuses when titles are turned off', async () => {
    const runner = recordingRunner(() => '')
    const generator = createTitleGenerator({
      setting: () => ({ provider: 'off', model: '' }),
      run: runner.run,
    })
    await expect(generator.generate({ message: 'x' })).rejects.toMatchObject({ reason: 'off' })
    expect(runner.requests).toEqual([])
  })

  it('runs Claude Code headless, without tools or a saved transcript', async () => {
    const runner = recordingRunner((request) => {
      expect(existsSync(join(request.cwd, 'settings.json'))).toBe(true)
      return JSON.stringify({
        type: 'result',
        is_error: false,
        result: '',
        structured_output: { title: 'Fix Login Redirect', needsRefinement: false },
      })
    })
    const generator = createTitleGenerator({
      setting: () => ({ provider: 'claude', model: '' }),
      env,
      run: runner.run,
    })
    await expect(generator.generate({ message: 'fix the login redirect' })).resolves.toEqual({
      title: 'Fix Login Redirect',
      needsRefinement: false,
    })
    const [request] = runner.requests
    expect(request!.command).toBe(process.execPath)
    expect(request!.args).toEqual(
      expect.arrayContaining([
        '--model',
        'haiku',
        '--no-session-persistence',
        '--disable-slash-commands',
        '--json-schema',
      ]),
    )
    expect(request!.args[request!.args.indexOf('--tools') + 1]).toBe('')
    expect(request!.input).toContain('User message:\nfix the login redirect')
    // The empty folder a title runs in is gone afterwards.
    expect(existsSync(request!.cwd)).toBe(false)
  })

  it('reads the answer Codex writes to its last-message file', async () => {
    const runner = recordingRunner(async (request) => {
      const schema = JSON.parse(
        await readFile(request.args[request.args.indexOf('--output-schema') + 1]!, 'utf8'),
      )
      expect(schema.required).toEqual(['title', 'needsRefinement'])
      await writeFile(
        request.args[request.args.indexOf('--output-last-message') + 1]!,
        '{"title":"Fix Login Redirect","needsRefinement":true}',
      )
      return ''
    })
    const generator = createTitleGenerator({
      setting: () => ({ provider: 'codex', model: '' }),
      env: { ...env, CODEX_BIN: 'codex-dev' },
      run: runner.run,
    })
    await expect(generator.generate({ message: 'x' })).resolves.toEqual({
      title: 'Fix Login Redirect',
      needsRefinement: true,
    })
    const [request] = runner.requests
    expect(request!.command).toBe('codex-dev')
    expect(request!.args).toEqual(
      expect.arrayContaining(['exec', '--ephemeral', '--model', 'gpt-6-luna', '-']),
    )
  })

  it('hands Cursor its request as a file it reads in ask mode', async () => {
    const runner = recordingRunner(async (request) => {
      const file = await readFile(join(request.cwd, 'title-request.md'), 'utf8')
      expect(file).toContain('User message:\nfix the login redirect')
      return `${JSON.stringify({ type: 'result', result: '{"title":"Fix Login Redirect"}' })}\n`
    })
    const generator = createTitleGenerator({
      setting: () => ({ provider: 'cursor', model: 'auto' }),
      env: { ...env, ACP_CURSOR_BIN: 'cursor-agent' },
      run: runner.run,
    })
    await expect(generator.generate({ message: 'fix the login redirect' })).resolves.toMatchObject({
      title: 'Fix Login Redirect',
    })
    const [request] = runner.requests
    expect(request!.command).toBe('cursor-agent')
    expect(request!.args).toEqual(
      expect.arrayContaining(['-p', '--mode', 'ask', '--model', 'auto', '--workspace']),
    )
    expect(request!.input).toBeUndefined()
  })

  it('deletes the session OpenCode saved for the title', async () => {
    const runner = recordingRunner((request) => {
      if (request.args[0] === 'session') return ''
      return [
        { type: 'step_start', sessionID: 'ses_1' },
        { type: 'text', sessionID: 'ses_1', part: { type: 'text', text: '{"title":"Fix ' } },
        { type: 'text', sessionID: 'ses_1', part: { type: 'text', text: 'Login"}' } },
      ]
        .map((event) => JSON.stringify(event))
        .join('\n')
    })
    const generator = createTitleGenerator({
      setting: () => ({ provider: 'opencode', model: '' }),
      env: { ...env, ACP_OPENCODE_BIN: 'opencode-dev' },
      run: runner.run,
    })
    await expect(generator.generate({ message: 'x' })).resolves.toMatchObject({
      title: 'Fix Login',
    })
    expect(runner.requests.map((request) => request.args)).toEqual([
      ['run', '--format', 'json', '--agent', 'plan'],
      ['session', 'delete', 'ses_1'],
    ])
  })

  it('deletes the OpenCode session of a run that failed after saving it', async () => {
    const runner = recordingRunner((request) => {
      if (request.args[0] === 'session') return ''
      throw new CliError(
        'opencode exited with code 1',
        JSON.stringify({ type: 'step_start', sessionID: 'ses_2' }),
      )
    })
    const generator = createTitleGenerator({
      setting: () => ({ provider: 'opencode', model: '' }),
      env: { ...env, ACP_OPENCODE_BIN: 'opencode-dev' },
      run: runner.run,
    })
    await expect(generator.generate({ message: 'x' })).rejects.toMatchObject({ reason: 'failed' })
    expect(runner.requests.map((request) => request.args)).toEqual([
      ['run', '--format', 'json', '--agent', 'plan'],
      ['session', 'delete', 'ses_2'],
    ])
  })

  it('reports a failed or empty answer as a failure, not a title', async () => {
    const logged: string[] = []
    const failing = createTitleGenerator({
      setting: () => ({ provider: 'codex', model: 'gpt-x' }),
      env,
      run: async () => {
        throw new Error('codex exited with code 1')
      },
      log: (_level, message) => logged.push(message),
    })
    const error = await failing.generate({ message: 'x' }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(TitleGenerationError)
    expect(error).toMatchObject({ reason: 'failed', message: 'Codex could not write a title.' })
    expect(logged).toEqual(['Session title generation failed'])

    const empty = createTitleGenerator({
      setting: () => ({ provider: 'claude', model: '' }),
      env,
      run: async () => JSON.stringify({ type: 'result', result: 'I cannot help with that.' }),
    })
    await expect(empty.generate({ message: 'x' })).rejects.toMatchObject({ reason: 'failed' })
  })
})

describe('running a title CLI', () => {
  it.skipIf(process.platform === 'win32')(
    'kills a CLI that ignores SIGTERM, and what it started, when stopped',
    { timeout: 15_000 },
    async () => {
      const controller = new AbortController()
      const script = [
        "process.on('SIGTERM', () => {})",
        "require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' })",
        "console.log('started')",
        'setInterval(() => {}, 1000)',
      ].join(';')
      const started = Date.now()
      const run = runCli({
        command: process.execPath,
        args: ['-e', script],
        cwd: process.cwd(),
        env: process.env,
        timeoutMs: 60_000,
        signal: controller.signal,
      })
      setTimeout(() => controller.abort(), 500)
      const error = await run.catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(CliError)
      expect((error as CliError).stdout).toContain('started')
      // Bounded by the kill grace, not the 60 s timeout, even with a
      // grandchild holding the output pipes open.
      expect(Date.now() - started).toBeLessThan(8_000)
    },
  )
})
