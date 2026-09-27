import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  acpCommandBin,
  cursor,
  opencode,
  providers,
  resolveClaudeExecutable,
  jsonObjects,
  type ClaudeProviderConfig,
} from '@agentpack/runtime/node'
import {
  DEFAULT_TITLE_GENERATION_MODELS,
  type TitleGenerationProvider,
  type TitleGenerationSetting,
} from '@openmanager/protocol/node'
import { needsShell, runCli, type CliRunner } from './cli.ts'
import {
  buildTitlePrompt,
  parseGeneratedTitle,
  TITLE_OUTPUT_SCHEMA,
  type GeneratedTitle,
  type TitlePromptInput,
} from './prompts.ts'

/** Why no title came back. `off` is a choice and `aborted` a title nobody
 * needs any more (a newer one was asked for, or the server is closing);
 * neither is a fault. */
export type TitleGenerationFailure = 'off' | 'failed' | 'aborted'

export class TitleGenerationError extends Error {
  readonly reason: TitleGenerationFailure

  constructor(reason: TitleGenerationFailure, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'TitleGenerationError'
    this.reason = reason
  }
}

export type TitleGenerator = {
  generate(input: TitlePromptInput, signal?: AbortSignal): Promise<GeneratedTitle>
}

export type TitleGeneratorOptions = {
  /** Read on every call, so a changed setting applies to the next title. */
  setting: () => TitleGenerationSetting
  log?: (level: 'info' | 'warn', message: string, data?: Record<string, unknown>) => void
  env?: NodeJS.ProcessEnv
  /** How CLIs are run. Absent outside tests. */
  run?: CliRunner
  timeoutMs?: number
}

/** Long enough for a cold CLI start and a small model; a title is not worth more. */
export const TITLE_GENERATION_TIMEOUT_MS = 90_000

type Run = {
  model: string
  prompt: string
  cwd: string
  env: NodeJS.ProcessEnv
  run: CliRunner
  timeoutMs: number
  signal?: AbortSignal
}

/**
 * Titles sessions with whichever CLI the environment's setting names. Each
 * title is one short-lived process in an empty temporary folder, with no
 * tools that could touch a project and, where the CLI allows it, nothing kept
 * in the CLI's own history: a title is bookkeeping, not a conversation.
 */
export function createTitleGenerator(options: TitleGeneratorOptions): TitleGenerator {
  const run = options.run ?? runCli
  const timeoutMs = options.timeoutMs ?? TITLE_GENERATION_TIMEOUT_MS
  return {
    async generate(input, signal) {
      const setting = options.setting()
      if (setting.provider === 'off')
        throw new TitleGenerationError('off', 'Title generation is turned off.')
      const provider = setting.provider
      const model = setting.model.trim() || DEFAULT_TITLE_GENERATION_MODELS[provider]
      const cwd = await mkdtemp(join(tmpdir(), 'openmanager-title-'))
      const env = options.env ?? process.env
      try {
        const answer = await RUNNERS[provider]({
          model,
          prompt: buildTitlePrompt(input),
          cwd,
          env,
          run,
          timeoutMs,
          ...(signal ? { signal } : {}),
        })
        const title = parseGeneratedTitle(answer)
        if (!title) throw new Error('The answer had no title in it.')
        return title
      } catch (error) {
        if (error instanceof TitleGenerationError) throw error
        if (signal?.aborted)
          throw new TitleGenerationError('aborted', 'The title was no longer needed.', {
            cause: error,
          })
        const message = error instanceof Error ? error.message : String(error)
        options.log?.('warn', 'Session title generation failed', { provider, model, message })
        throw new TitleGenerationError(
          'failed',
          `${PROVIDER_NAMES[provider]} could not write a title.`,
          { cause: error },
        )
      } finally {
        await rm(cwd, { recursive: true, force: true }).catch(() => undefined)
      }
    },
  }
}

const PROVIDER_NAMES: Record<Exclude<TitleGenerationProvider, 'off'>, string> = {
  codex: 'Codex',
  claude: 'Claude Code',
  cursor: 'Cursor',
  opencode: 'OpenCode',
}

const RUNNERS: Record<Exclude<TitleGenerationProvider, 'off'>, (run: Run) => Promise<unknown>> = {
  claude: runClaude,
  codex: runCodex,
  cursor: runCursor,
  opencode: runOpencode,
}

/**
 * `claude -p` with no tools, hooks, slash commands or MCP servers, and no
 * transcript written: a titled session would otherwise show up in the user's
 * Claude Code history as a conversation of its own.
 */
async function runClaude({ model, prompt, cwd, env, run, timeoutMs, signal }: Run) {
  const command = resolveClaudeExecutable(providers.claude as ClaudeProviderConfig, env)
  const settingsPath = join(cwd, 'settings.json')
  await writeFile(settingsPath, JSON.stringify({ disableAllHooks: true }))
  const stdout = await run({
    command,
    args: [
      '-p',
      '--output-format',
      'json',
      '--model',
      model,
      '--tools',
      '',
      '--disable-slash-commands',
      '--strict-mcp-config',
      '--permission-mode',
      'dontAsk',
      '--no-session-persistence',
      '--settings',
      settingsPath,
      // The schema is JSON, which cannot pass through `cmd.exe` intact. A
      // shimmed install answers from the prompt's own instructions instead.
      ...(needsShell(command) ? [] : ['--json-schema', JSON.stringify(TITLE_OUTPUT_SCHEMA)]),
    ],
    input: prompt,
    cwd,
    env,
    timeoutMs,
    ...(signal ? { signal } : {}),
  })
  const envelope = lastResult(jsonObjects(stdout))
  if (!envelope) throw new Error('Claude Code printed no result.')
  if (envelope.is_error === true) throw new Error(`Claude Code: ${String(envelope.result)}`)
  return envelope.structured_output ?? envelope.result
}

function lastResult(objects: Record<string, unknown>[]) {
  return [...objects].reverse().find((object) => object.type === 'result')
}

/** `codex exec`, ephemeral and read-only, with the answer held to the schema. */
async function runCodex({ model, prompt, cwd, env, run, timeoutMs, signal }: Run) {
  const schemaPath = join(cwd, 'schema.json')
  const answerPath = join(cwd, 'answer.json')
  await writeFile(schemaPath, JSON.stringify(TITLE_OUTPUT_SCHEMA))
  await run({
    command: env.CODEX_BIN?.trim() || 'codex',
    args: [
      'exec',
      '--ephemeral',
      '--skip-git-repo-check',
      '--sandbox',
      'read-only',
      '--color',
      'never',
      '--model',
      model,
      '--config',
      'model_reasoning_effort=low',
      '--output-schema',
      schemaPath,
      '--output-last-message',
      answerPath,
      '-',
    ],
    input: prompt,
    cwd,
    env,
    timeoutMs,
    ...(signal ? { signal } : {}),
  })
  return readFile(answerPath, 'utf8')
}

const CURSOR_REQUEST_FILE = 'title-request.md'

/**
 * Cursor's print mode takes its prompt only as an argument, and a whole
 * conversation cannot ride a Windows command line. So the request is a file
 * in the empty folder the agent runs in, and the agent reads it in `ask`
 * mode, which cannot edit or run anything.
 */
async function runCursor({ model, prompt, cwd, env, run, timeoutMs, signal }: Run) {
  await writeFile(join(cwd, CURSOR_REQUEST_FILE), prompt)
  const stdout = await run({
    command: acpCommandBin(cursor.command, env),
    args: [
      '-p',
      '--output-format',
      'json',
      '--mode',
      'ask',
      '--trust',
      '--workspace',
      cwd,
      ...(model ? ['--model', model] : []),
      `Read ${CURSOR_REQUEST_FILE} in this folder and follow it. Reply with only the JSON it asks for.`,
    ],
    cwd,
    env,
    timeoutMs,
    ...(signal ? { signal } : {}),
  })
  const envelope = lastResult(jsonObjects(stdout))
  if (!envelope) throw new Error('Cursor printed no result.')
  if (envelope.is_error === true) throw new Error(`Cursor: ${String(envelope.result)}`)
  return envelope.result
}

/**
 * `opencode run` with the read-only `plan` agent. OpenCode saves every run as
 * a session, so the one a title created is deleted once it has answered;
 * otherwise each titled session would leave a stray one in OpenCode's list.
 */
async function runOpencode({ model, prompt, cwd, env, run, timeoutMs, signal }: Run) {
  const command = acpCommandBin(opencode.command, env)
  const stdout = await run({
    command,
    args: ['run', '--format', 'json', '--agent', 'plan', ...(model ? ['--model', model] : [])],
    input: prompt,
    cwd,
    env,
    timeoutMs,
    ...(signal ? { signal } : {}),
  })
  const events = jsonObjects(stdout)
  const sessionId = events.map((event) => event.sessionID).find((id) => typeof id === 'string')
  if (typeof sessionId === 'string') {
    await run({
      command,
      args: ['session', 'delete', sessionId],
      cwd,
      env,
      timeoutMs: 15_000,
    }).catch(() => undefined)
  }
  const failure = events.find((event) => event.type === 'error')
  if (failure) throw new Error(`OpenCode: ${JSON.stringify(failure.error)}`)
  return events
    .flatMap((event) => {
      const part = event.part as { type?: unknown; text?: unknown } | undefined
      return event.type === 'text' && part?.type === 'text' && typeof part.text === 'string'
        ? [part.text]
        : []
    })
    .join('')
}
