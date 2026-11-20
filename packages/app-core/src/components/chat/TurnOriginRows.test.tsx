import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { OperationPrompt } from './TurnOriginRows'

describe('OperationPrompt (CAL-268)', () => {
  it('opens a review turn with what it reviews and the command as typed', () => {
    const html = renderToStaticMarkup(
      <OperationPrompt content="/review base main" origin="review" />,
    )
    expect(html).toContain('data-turn-origin="review"')
    expect(html).toContain('Code review')
    expect(html).toContain('changes against main')
    expect(html).toContain('/review')
  })

  it('opens a compaction turn with what it does', () => {
    const html = renderToStaticMarkup(<OperationPrompt content="/compact" origin="compact" />)
    expect(html).toContain('data-turn-origin="compact"')
    expect(html).toContain('Compact the conversation')
  })
})
