import { describe, expect, it, vi } from 'vitest'
import {
  createOpencodeModelImageInputLookup,
  jsonObjects,
  listOpencodeModels,
  type ExecFile,
} from './opencode-models.js'

const model = (providerID: string, id: string, image: boolean | 'missing') =>
  JSON.stringify({
    id,
    providerID,
    name: id,
    ...(image === 'missing' ? {} : { capabilities: { input: { image, text: true } } }),
  })

/** The `--pure` stream: one object per line, with a banner the parser must skip. */
const ANTHROPIC_LISTING = [
  'opencode 1.18.3',
  model('anthropic', 'claude-sonnet-4', true),
  model('anthropic', 'claude-haiku-3', false),
  model('anthropic', 'claude-legacy', 'missing'),
].join('\n')

function build(listings: Record<string, string | Error>) {
  const execFile = vi.fn<ExecFile>(async (_command, args) => {
    const listing = listings[args[1]!]
    if (listing instanceof Error) throw listing
    if (listing === undefined) throw new Error(`unexpected provider ${args[1]}`)
    return { stdout: listing }
  })
  const log = vi.fn()
  let clock = 0
  const lookup = createOpencodeModelImageInputLookup({
    command: 'opencode',
    execFile,
    log,
    failureHoldMs: 1_000,
    now: () => clock,
  })
  return { lookup, execFile, log, advance: (ms: number) => (clock += ms) }
}

describe('jsonObjects', () => {
  it('finds every top-level object in a stream, whatever surrounds it', () => {
    // A banner line, a brace inside a string, a nested object, and an object
    // that never closes: only the well-formed top-level ones come back.
    const output = ['banner', '{"a":1}', '{"b":"}"}', '{"x":}', '{"c":{"nested":true}}', '{"open":'].join(
      '\n',
    )
    expect(jsonObjects(output)).toEqual([{ a: 1 }, { b: '}' }, { c: { nested: true } }])
  })
})

describe('OpenCode model catalog', () => {
  /** The `--verbose` stream as the CLI prints it: a `provider/model` heading
   * line, then that model as a pretty-printed object. */
  const printed = (model: Record<string, unknown>) =>
    [`${String(model.providerID)}/${String(model.id)}`, JSON.stringify(model, null, 2)].join('\n')
  const LISTING = [
    printed({
      id: 'big-pickle',
      providerID: 'opencode',
      name: 'Big Pickle',
      limit: { context: 200_000, output: 32_000 },
      capabilities: { input: { text: true, image: false } },
    }),
    printed({
      id: 'gpt-5.4',
      providerID: 'openai',
      name: 'GPT-5.4',
      limit: { context: 400_000 },
      capabilities: { input: { text: true, image: true } },
    }),
    printed({ id: 'gpt-5.4', providerID: 'github-copilot', name: 'GPT-5.4' }),
  ].join('\n')

  const list = (
    stdout: string | Error,
    options: { cwd?: string; signal?: AbortSignal } = {},
  ) => {
    const execFile = vi.fn<ExecFile>(async () => {
      if (stdout instanceof Error) throw stdout
      return { stdout }
    })
    return {
      execFile,
      listing: listOpencodeModels({ command: 'opencode', execFile, ...options }),
    }
  }

  it('lists every model from one CLI call, under the ids a session accepts', async () => {
    const { execFile, listing } = list(LISTING)
    await expect(listing).resolves.toEqual({
      availableModels: [
        {
          id: 'opencode/big-pickle',
          displayName: 'opencode/Big Pickle',
          contextWindowTokens: 200_000,
          supportsImageInput: false,
        },
        {
          id: 'openai/gpt-5.4',
          displayName: 'openai/GPT-5.4',
          contextWindowTokens: 400_000,
          supportsImageInput: true,
        },
        // Two upstream providers offer a "GPT-5.4"; the label keeps them apart.
        // Nothing is claimed about a model the CLI said nothing about.
        { id: 'github-copilot/gpt-5.4', displayName: 'github-copilot/GPT-5.4' },
      ],
    })
    expect(execFile).toHaveBeenCalledTimes(1)
    expect(execFile).toHaveBeenCalledWith(
      'opencode',
      ['models', '--verbose', '--pure'],
      expect.objectContaining({ windowsHide: true, timeout: 30_000 }),
    )
  })

  it('skips what it cannot identify and lists a model once', async () => {
    const { listing } = list(
      [
        'a banner line',
        printed({ id: 'big-pickle', providerID: 'opencode', name: '  ' }),
        printed({ id: 'big-pickle', providerID: 'opencode', name: 'Again' }),
        JSON.stringify({ id: 'no-provider' }),
        JSON.stringify({ providerID: 'openai' }),
        JSON.stringify({ id: '', providerID: 'openai' }),
        '{"id": "broken",',
      ].join('\n'),
    )
    await expect(listing).resolves.toEqual({
      // A blank name falls back to the model's own id.
      availableModels: [{ id: 'opencode/big-pickle', displayName: 'opencode/big-pickle' }],
    })
  })

  it('answers empty, not an empty catalog, when the CLI printed no models', async () => {
    await expect(list('opencode 1.18.32\n').listing).resolves.toEqual({})
  })

  it('rejects when the CLI cannot be run', async () => {
    await expect(list(new Error('spawn opencode ENOENT')).listing).rejects.toThrow('ENOENT')
  })

  it('runs in the folder it is asked about, under the control of whoever asked', async () => {
    const { signal } = new AbortController()
    const { execFile, listing } = list(LISTING, { cwd: 'C:/workspace', signal })
    await listing
    expect(execFile).toHaveBeenCalledWith(
      'opencode',
      ['models', '--verbose', '--pure'],
      expect.objectContaining({ cwd: 'C:/workspace', signal }),
    )
  })

  it('names no folder and no signal when it was given none', async () => {
    const { execFile, listing } = list(LISTING)
    await listing
    const options = execFile.mock.calls[0]![2]
    expect('cwd' in options).toBe(false)
    expect('signal' in options).toBe(false)
  })
})

describe('OpenCode model image input lookup', () => {
  it('answers from one listing per upstream provider and caches the whole catalog', async () => {
    const { lookup, execFile } = build({ anthropic: ANTHROPIC_LISTING })
    await expect(lookup(['anthropic/claude-sonnet-4', 'anthropic/claude-haiku-3'])).resolves.toEqual(
      new Map([
        ['anthropic/claude-sonnet-4', true],
        ['anthropic/claude-haiku-3', false],
      ]),
    )
    expect(execFile).toHaveBeenCalledTimes(1)
    expect(execFile).toHaveBeenCalledWith(
      'opencode',
      ['models', 'anthropic', '--verbose', '--pure'],
      expect.objectContaining({ windowsHide: true }),
    )
    // A model printed in that listing but not asked about is already known.
    await expect(lookup(['anthropic/claude-legacy'])).resolves.toEqual(
      new Map([['anthropic/claude-legacy', null]]),
    )
    expect(execFile).toHaveBeenCalledTimes(1)
  })

  it('reports ids that are not OpenCode model ids as unknown without spawning', async () => {
    const { lookup, execFile } = build({})
    await expect(lookup(['sonnet', '/leading'])).resolves.toEqual(
      new Map([
        ['sonnet', null],
        ['/leading', null],
      ]),
    )
    expect(execFile).not.toHaveBeenCalled()
  })

  it('remembers a model the CLI did not print, so it is not asked for again', async () => {
    const { lookup, execFile } = build({ anthropic: ANTHROPIC_LISTING })
    await lookup(['anthropic/unlisted'])
    await expect(lookup(['anthropic/unlisted'])).resolves.toEqual(
      new Map([['anthropic/unlisted', null]]),
    )
    expect(execFile).toHaveBeenCalledTimes(1)
  })

  it('shares one in-flight listing between concurrent asks for the same provider', async () => {
    const { lookup, execFile } = build({ anthropic: ANTHROPIC_LISTING })
    const [first, second] = await Promise.all([
      lookup(['anthropic/claude-sonnet-4']),
      lookup(['anthropic/claude-haiku-3']),
    ])
    expect(first.get('anthropic/claude-sonnet-4')).toBe(true)
    expect(second.get('anthropic/claude-haiku-3')).toBe(false)
    expect(execFile).toHaveBeenCalledTimes(1)
  })

  it('holds a failed listing so a broken CLI is not respawned per model, then retries', async () => {
    const listings: Record<string, string | Error> = { openai: new Error('ENOENT') }
    const { lookup, execFile, log, advance } = build(listings)
    // Not `null`: the CLI was not asked, so the id is left out for a retry.
    await expect(lookup(['openai/gpt-5'])).resolves.toEqual(new Map())
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'warn', data: expect.objectContaining({ provider: 'openai' }) }),
    )
    // A different model under the same provider inside the hold: no spawn.
    await expect(lookup(['openai/gpt-5-mini'])).resolves.toEqual(new Map())
    expect(execFile).toHaveBeenCalledTimes(1)
    // After the hold the CLI is asked again, and a fixed CLI answers.
    listings.openai = model('openai', 'gpt-5', true)
    advance(1_001)
    await expect(lookup(['openai/gpt-5'])).resolves.toEqual(new Map([['openai/gpt-5', true]]))
    expect(execFile).toHaveBeenCalledTimes(2)
  })
})
