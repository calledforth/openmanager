// @vitest-environment jsdom
import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { UserMessage } from '../src/components/chat/UserMessage'
import {
  EnvironmentAvailabilityContext,
  useFailureNamer,
} from '../src/providers/environment-availability'

const onLaptop = (element: ReactElement) => (
  <EnvironmentAvailabilityContext.Provider value={{ name: 'Laptop', sendBlockedReason: null }}>
    {element}
  </EnvironmentAvailabilityContext.Provider>
)

function Named({ message }: { message: string }) {
  return <p>{useFailureNamer()(message)}</p>
}

describe('naming the environment a failure is about', () => {
  it('puts the name on a failure where the host gives one', () => {
    expect(renderToStaticMarkup(onLaptop(<Named message="Refused." />))).toContain(
      'Laptop: Refused.',
    )
  })

  it('leaves a failure as it is on a host that gives none', () => {
    expect(renderToStaticMarkup(<Named message="Refused." />)).toBe('<p>Refused.</p>')
  })

  it('says where a message was not sent', () => {
    const html = renderToStaticMarkup(
      onLaptop(<UserMessage content="Hello" sendError="Refused." />),
    )
    expect(html).toContain('Not sent to Laptop')
  })

  it('reads as it did with no environment to name', () => {
    const html = renderToStaticMarkup(<UserMessage content="Hello" sendError="Refused." />)
    expect(html).toContain('Not sent')
    expect(html).not.toContain('Not sent to')
  })
})
