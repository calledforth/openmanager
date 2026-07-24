import { describe, expect, it } from 'vitest'
import {
  applySlashCommand,
  matchSlashCommands,
  slashQueryFromText,
  type SlashCommandItem,
} from './slashCommands'

// Names taken from live `available_commands_update` payloads (2026-07-24):
// cursor-agent 2026.07.23 (19 commands) and opencode 1.17.15 (5 commands).
const cursorCommands: SlashCommandItem[] = [
  { name: 'copy-request-id', description: 'Copy the last request ID to clipboard' },
  { name: 'multi-model-review', description: 'Pick models, then parallel Task reviewers' },
  { name: 'simplify', description: 'Find low-info comments and reuse opportunities.' },
  { name: 'create-rule', description: 'Create Cursor rules for persistent AI guidance.' },
  { name: 'create-skill', description: 'Create Cursor Agent Skills.' },
  { name: 'review-agent', description: 'Perform a read-only, defect-first review.' },
]

describe('slashQueryFromText', () => {
  it('detects a bare command being typed', () => {
    expect(slashQueryFromText('/')).toBe('')
    expect(slashQueryFromText('/simp')).toBe('simp')
  })

  it('accepts hyphens, since provider command names use them', () => {
    expect(slashQueryFromText('/copy-request-id')).toBe('copy-request-id')
  })

  it('lowercases so matching is case-insensitive', () => {
    expect(slashQueryFromText('/Simp')).toBe('simp')
  })

  it('closes once arguments start, so the picker stops competing with Enter', () => {
    expect(slashQueryFromText('/review ')).toBeNull()
    expect(slashQueryFromText('/review the diff')).toBeNull()
  })

  it('ignores a slash that is not at the start of the draft', () => {
    expect(slashQueryFromText('fix and/or revert')).toBeNull()
    expect(slashQueryFromText('please /simplify')).toBeNull()
    expect(slashQueryFromText('')).toBeNull()
  })
})

describe('matchSlashCommands', () => {
  it('lists every command for a bare slash', () => {
    expect(matchSlashCommands(cursorCommands, '')).toHaveLength(cursorCommands.length)
  })

  it('ranks prefix matches above interior matches', () => {
    const names = matchSlashCommands(cursorCommands, 'review').map((c) => c.name)
    expect(names).toEqual(['review-agent', 'multi-model-review'])
  })

  it('sorts equally-ranked matches alphabetically', () => {
    const names = matchSlashCommands(cursorCommands, 'create').map((c) => c.name)
    expect(names).toEqual(['create-rule', 'create-skill'])
  })

  it('matches on name only — descriptions would match far too broadly', () => {
    // "Copy" appears in copy-request-id's description but no command name.
    expect(matchSlashCommands(cursorCommands, 'clipboard')).toEqual([])
  })

  it('returns nothing when the query matches no command, which hides the picker', () => {
    expect(matchSlashCommands(cursorCommands, 'zzz')).toEqual([])
  })
})

describe('applySlashCommand', () => {
  it('completes to a name plus a space, leaving the draft ready for arguments', () => {
    expect(applySlashCommand({ name: 'simplify', description: '' })).toBe('/simplify ')
  })

  it('produces text that is no longer in slash context, so the picker closes', () => {
    const next = applySlashCommand({ name: 'review-agent', description: '' })
    expect(slashQueryFromText(next)).toBeNull()
  })
})
