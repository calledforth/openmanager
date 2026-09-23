import { describe, expect, it, vi } from 'vitest'
import { createOpencodeModelImageInputLookup, jsonObjects, type ExecFile } from './opencode-models.js'

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
    await expect(lookup(['openai/gpt-5'])).resolves.toEqual(new Map([['openai/gpt-5', null]]))
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'warn', data: expect.objectContaining({ provider: 'openai' }) }),
    )
    // A different model under the same provider inside the hold: no spawn.
    await expect(lookup(['openai/gpt-5-mini'])).resolves.toEqual(
      new Map([['openai/gpt-5-mini', null]]),
    )
    expect(execFile).toHaveBeenCalledTimes(1)
    // After the hold the CLI is asked again, and a fixed CLI answers.
    listings.openai = model('openai', 'gpt-5', true)
    advance(1_001)
    await expect(lookup(['openai/gpt-5'])).resolves.toEqual(new Map([['openai/gpt-5', true]]))
    expect(execFile).toHaveBeenCalledTimes(2)
  })
})
