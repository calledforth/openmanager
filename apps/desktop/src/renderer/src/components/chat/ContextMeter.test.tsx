import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ContextMeter } from './ContextMeter'

const CIRCUMFERENCE = 2 * Math.PI * 9

/** The progress arc's dash offset, which is what actually draws the fill. */
function dashOffset(html: string): number {
  const offsets = [...html.matchAll(/stroke-dashoffset="([\d.]+)"/g)].map((m) => Number(m[1]))
  expect(offsets).toHaveLength(1)
  return offsets[0]
}

describe('ContextMeter', () => {
  it('draws an empty ring at 0%', () => {
    const html = renderToStaticMarkup(
      <ContextMeter usage={{ used: 0, size: 200000, percent: 0 }} />,
    )
    expect(dashOffset(html)).toBeCloseTo(CIRCUMFERENCE, 5)
  })

  it('draws a half ring at 50%', () => {
    const html = renderToStaticMarkup(
      <ContextMeter usage={{ used: 100000, size: 200000, percent: 50 }} />,
    )
    expect(dashOffset(html)).toBeCloseTo(CIRCUMFERENCE / 2, 5)
  })

  it('closes the ring at 100%', () => {
    const html = renderToStaticMarkup(
      <ContextMeter usage={{ used: 200000, size: 200000, percent: 100 }} />,
    )
    expect(dashOffset(html)).toBeCloseTo(0, 5)
  })

  it('clamps out-of-range percentages rather than overdrawing the arc', () => {
    const over = renderToStaticMarkup(
      <ContextMeter usage={{ used: 210000, size: 200000, percent: 140 }} />,
    )
    expect(dashOffset(over)).toBeCloseTo(0, 5)
  })

  it('renders no visible text — the figures belong to the hover card', () => {
    const html = renderToStaticMarkup(
      <ContextMeter usage={{ used: 19433, size: 200000, percent: 9.7165 }} />,
    )
    // Attributes carry the a11y label; stripping tags leaves only drawn text.
    expect(html.replace(/<[^>]*>/g, '')).toBe('')
  })

  it('exposes the percentage to assistive tech even though it is not drawn', () => {
    const html = renderToStaticMarkup(
      <ContextMeter usage={{ used: 19433, size: 200000, percent: 9.7165 }} />,
    )
    expect(html).toContain('aria-label="Context window 10% full"')
  })

  it('never reports a non-empty context as 0% full', () => {
    const html = renderToStaticMarkup(
      <ContextMeter usage={{ used: 120, size: 200000, percent: 0.06 }} />,
    )
    expect(html).toContain('aria-label="Context window 1% full"')
  })
})
