import { deriveConnectionUi } from '@openmanager/environment-client/connection'
import { describe, expect, it } from 'vitest'
import { CONNECTION_STORIES, ROUTE_FAILURE_STORIES } from './connection-states'

/** Route failures that need a person, so they never show the reconnect strip. */
const PERSON_NEEDED = new Set(['credential_rejected', 'local_access_blocked'])

/** Kinds that keep the shell mounted instead of replacing it. */
const BANNER_KINDS = new Set(['connecting', 'reconnecting', 'offline', 'unreachable'])

describe('connection story fixtures', () => {
  it('maps each story fixture to its named state and surface', () => {
    for (const story of CONNECTION_STORIES) {
      const ui = deriveConnectionUi(story.input)
      // A variant's id is its kind followed by what sets it apart.
      expect(story.id.startsWith(ui.kind), story.id).toBe(true)
      expect(ui.surface, story.id).toBe(BANNER_KINDS.has(ui.kind) ? 'banner' : 'screen')
      expect(ui.title.length, story.id).toBeGreaterThan(0)
      expect(ui.description.length, story.id).toBeGreaterThan(0)
    }
  })

  it('shows every reason that waiting resolves as the same reconnect state', () => {
    const details = new Set<string>()
    const waiting = ROUTE_FAILURE_STORIES.filter((story) => !PERSON_NEEDED.has(story.id))
    for (const story of waiting) {
      const ui = deriveConnectionUi(story.input)
      expect(ui, story.id).toMatchObject({
        surface: 'banner',
        title: "Can't reach Rajku's laptop",
        description: 'Trying to reconnect…',
        retrying: true,
        action: 'retry',
        secondaryAction: 'change_environment',
      })
      // The reason itself is kept for debugging. A variant's id is its
      // reason followed by what sets it apart.
      if (story.id !== 'route_search') {
        expect(story.id.startsWith(ui.reason!), story.id).toBe(true)
      }
      details.add(ui.detail!)
    }
    // Each cause still says something different on its one line.
    expect(details.size).toBe(waiting.length)
  })
})
