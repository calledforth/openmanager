import type { ProofEvent } from '@openmanager/protocol/node'
import { openComposerStore, type ComposerStore } from '../../src/composer-store.js'
import { openEnvironmentDatabase } from '../../src/db/database.js'
import { createPersistentEventService } from '../../src/event-service.js'

/**
 * A composer store wired as the host wires it: on the event database's
 * connection, writing through the event service, so every profile and
 * preference change is an event whose projection writes the row. `onEvent`
 * hears each committed event, as a connected client would. Closing the store
 * closes its connection.
 */
export function openTestComposerStore(
  dataDir: string,
  onEvent: (event: ProofEvent) => void = () => undefined,
): ComposerStore {
  const database = openEnvironmentDatabase(dataDir)
  const events = createPersistentEventService(database, (record) => onEvent(record.event))
  const store = openComposerStore({
    database,
    environmentId: 'environment-1',
    appendAtomic: (batch) => events.appendAtomic(batch),
  })
  let closed = false
  return {
    ...store,
    close() {
      if (closed) return
      closed = true
      events.close()
      database.close()
    },
  }
}
