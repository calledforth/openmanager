import { describeTurnOperation, parseTurnOperation } from '@agentpack/contract'
import { describe, expect, it } from 'vitest'
import { codexReviewTarget } from '../session/codex/CodexSessionRuntime.js'

describe('parseTurnOperation', () => {
  it.each([
    ['/compact', { kind: 'compact' }],
    ['  /compact  ', { kind: 'compact' }],
    // Kept, so a provider whose compaction takes none can say it did not use them.
    ['/compact keep the API notes', { kind: 'compact', instructions: 'keep the API notes' }],
    ['/Compact', { kind: 'compact' }],
    ['/REVIEW Base main', { kind: 'review', target: { type: 'base_branch', branch: 'main' } }],
    // Not a sha: the whole is instructions.
    ['/review commit the login fix', { kind: 'review', target: { type: 'custom', instructions: 'commit the login fix' } }],
    ['/review commit abc12', { kind: 'review', target: { type: 'custom', instructions: 'commit abc12' } }],
    ['/review', { kind: 'review', target: { type: 'uncommitted_changes' } }],
    ['/review uncommitted', { kind: 'review', target: { type: 'uncommitted_changes' } }],
    ['/review base main', { kind: 'review', target: { type: 'base_branch', branch: 'main' } }],
    ['/review commit 1a2b3c4', { kind: 'review', target: { type: 'commit', sha: '1a2b3c4' } }],
    [
      '/review commit 1a2b3c4 Fix the login bug',
      { kind: 'review', target: { type: 'commit', sha: '1a2b3c4', title: 'Fix the login bug' } },
    ],
    [
      '/review focus on error handling\nin auth.ts',
      { kind: 'review', target: { type: 'custom', instructions: 'focus on error handling\nin auth.ts' } },
    ],
  ])('reads %j', (text, operation) => {
    expect(parseTurnOperation(text)).toEqual(operation)
  })

  it.each(['/reviews', '/compactly', 'please /review', 'review', '/help', ''])(
    'leaves %j a prompt',
    (text) => {
      expect(parseTurnOperation(text)).toBeUndefined()
    },
  )

  it('runs only what the provider offers', () => {
    expect(parseTurnOperation('/compact', ['review'])).toBeUndefined()
    expect(parseTurnOperation('/review', ['review'])).toMatchObject({ kind: 'review' })
    expect(parseTurnOperation('/review', [])).toBeUndefined()
  })

  it('says what ran in a few words', () => {
    expect(describeTurnOperation({ kind: 'compact' })).toEqual({ label: 'Compact the conversation' })
    expect(
      describeTurnOperation({ kind: 'review', target: { type: 'commit', sha: '1a2b3c4d5e', title: 'Fix it' } }),
    ).toEqual({ label: 'Code review', detail: 'commit 1a2b3c4 Fix it' })
  })
})

describe('codexReviewTarget', () => {
  it("spells each target as Codex's ReviewTarget", () => {
    expect(codexReviewTarget({ type: 'uncommitted_changes' })).toEqual({ type: 'uncommittedChanges' })
    expect(codexReviewTarget({ type: 'base_branch', branch: 'main' })).toEqual({ type: 'baseBranch', branch: 'main' })
    expect(codexReviewTarget({ type: 'commit', sha: 'abc1234' })).toEqual({ type: 'commit', sha: 'abc1234', title: null })
    expect(codexReviewTarget({ type: 'custom', instructions: 'look at auth' })).toEqual({
      type: 'custom',
      instructions: 'look at auth',
    })
  })
})
