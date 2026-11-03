import { describe, expect, it } from 'vitest'

import { matchesTerms, searchTerms } from '../src/home/search'

describe('search', () => {
  it('matches every typed word, in any order, across title and project', () => {
    const terms = searchTerms('tool pay')
    expect(matchesTerms(terms, 'Codex Integration: Tool Call Payloads', 'openmanager')).toBe(true)
    expect(matchesTerms(terms, 'Payloads first, tools later', undefined)).toBe(true)
    expect(matchesTerms(terms, 'Pricing page copy', 'salesmaxai')).toBe(false)
  })

  it('finds a project by name', () => {
    expect(matchesTerms(searchTerms('SALES'), 'Pricing page copy', 'salesmaxai')).toBe(true)
  })

  it('matches nothing on an empty query', () => {
    expect(searchTerms('   ')).toEqual([])
    expect(matchesTerms([], 'anything')).toBe(false)
  })
})
