import { describe, expect, it } from 'vitest'
import { parseCommandPill } from './command-pill'

describe('parseCommandPill', () => {
  it('keeps a bare command as the label', () => {
    expect(parseCommandPill('ls')).toEqual({
      label: 'ls',
      flags: [],
      hiddenFlagCount: 0,
      extraSegmentCount: 0,
    })
  })

  it('drops positional arguments and keeps flags', () => {
    const model = parseCommandPill('rg -n --glob "*.ts" presentToolPart src')
    expect(model.label).toBe('rg')
    expect(model.flags).toEqual(['-n', '--glob'])
  })

  it('includes the subcommand for known wrappers', () => {
    expect(parseCommandPill('git commit -m "fix things"').label).toBe('git commit')
    expect(parseCommandPill('docker compose up -d').label).toBe('docker compose')
  })

  it('keeps the script name for run-style subcommands', () => {
    expect(parseCommandPill('pnpm run build --filter desktop').label).toBe('pnpm run build')
  })

  it('normalizes flags with values and dedupes repeats', () => {
    const model = parseCommandPill('curl --url=https://x.dev --url=https://y.dev -s')
    expect(model.flags).toEqual(['--url', '-s'])
  })

  it('caps the flag list and reports the overflow', () => {
    const model = parseCommandPill('tar -c -z -v -f archive.tar.gz dir')
    expect(model.flags).toEqual(['-c', '-z', '-v'])
    expect(model.hiddenFlagCount).toBe(1)
  })

  it('counts chained segments instead of inlining them', () => {
    const model = parseCommandPill('cd apps/desktop && pnpm install && pnpm test')
    expect(model.label).toBe('cd')
    expect(model.extraSegmentCount).toBe(2)
  })

  it('does not split separators inside quotes or escaped arguments', () => {
    expect(parseCommandPill("rg 'a|b;c&&d' file").extraSegmentCount).toBe(0)
    expect(parseCommandPill('printf foo\\|bar').extraSegmentCount).toBe(0)
  })

  it('does not count command-substitution internals as top-level segments', () => {
    const model = parseCommandPill("echo $(printf 'a|b' && printf c) && npm test")
    expect(model.label).toBe('echo')
    expect(model.extraSegmentCount).toBe(1)
  })

  it('counts standalone background operators but not redirections', () => {
    expect(parseCommandPill('sleep 10 & echo done').extraSegmentCount).toBe(1)
    expect(parseCommandPill('echo hi 2>&1').extraSegmentCount).toBe(0)
    expect(parseCommandPill('echo hi &> output.log').extraSegmentCount).toBe(0)
  })

  it('does not count heredoc payload lines as commands', () => {
    const model = parseCommandPill('cat <<EOF\nhello;world | still-data\nEOF')
    expect(model.label).toBe('cat')
    expect(model.extraSegmentCount).toBe(0)
  })

  it('continues counting after a here-string', () => {
    expect(parseCommandPill('consumer <<< value && next').extraSegmentCount).toBe(1)
  })

  it('skips env assignments and transparent prefixes', () => {
    expect(parseCommandPill('sudo NODE_ENV=test npm test').label).toBe('npm test')
    expect(parseCommandPill('sudo -- npm test').label).toBe('npm test')
    expect(parseCommandPill('MESSAGE="hello world" npm test').label).toBe('npm test')
    expect(parseCommandPill('OUTPUT=$(printf "hello world") npm test').label).toBe('npm test')
  })

  it('keeps a transparent prefix visible when it has options', () => {
    expect(parseCommandPill('sudo -u root npm test').label).toBe('sudo')
  })

  it('returns an empty model for blank input', () => {
    expect(parseCommandPill('   ').label).toBe('')
  })
})
