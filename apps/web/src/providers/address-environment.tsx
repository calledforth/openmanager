import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import {
  isEnvironmentClientError,
  selectDraftTarget,
  type EnvironmentClient,
  type EnvironmentState,
} from '@openmanager/environment-client'
import { useConnection } from './connection-provider'
import { useEnvironmentClients } from './environment-client-provider'
import type { EnvironmentLink } from '../lib/environment-link'

/** What a page's address names. Nothing in it says which environment has that. */
export type Address = { kind: 'session' | 'draft'; id: string }

function idAfter(pathname: string, prefix: string): string | null {
  if (!pathname.startsWith(prefix)) return null
  const id = pathname.slice(prefix.length)
  if (!id || id.includes('/')) return null
  try {
    return decodeURIComponent(id)
  } catch {
    return null
  }
}

export function addressOf(pathname: string): Address | null {
  const sessionId = idAfter(pathname, '/sessions/')
  if (sessionId) return { kind: 'session', id: sessionId }
  const draftId = idAfter(pathname, '/drafts/')
  return draftId ? { kind: 'draft', id: draftId } : null
}

function holds(state: EnvironmentState, address: Address): boolean {
  return address.kind === 'draft'
    ? selectDraftTarget(state, address.id) !== undefined
    : Object.hasOwn(state.sessions, address.id) || state.activeSessionId === address.id
}

/**
 * Where an environment stands on an address it does not hold: it has said no,
 * it can be asked, it may yet say, or it cannot say.
 */
type Standing = 'no' | 'ask' | 'wait' | 'gone'

/** Still on its way, so what it would say is not known yet. */
const ON_ITS_WAY: ReadonlySet<EnvironmentLink['ui']['kind']> = new Set([
  'connecting',
  'reconnecting',
  'ready',
])

function standingOf(
  link: EnvironmentLink,
  client: EnvironmentClient | undefined,
  address: Address,
  absent: ReadonlySet<string>,
): Standing {
  const state = client?.getState()
  if (state?.connection.phase === 'connected') {
    // Every draft is listed, so a draft needs no question of its own.
    if (address.kind === 'draft') return state.draftsListed ? 'no' : 'wait'
    return absent.has(link.environmentId) ? 'no' : 'ask'
  }
  return ON_ITS_WAY.has(link.ui.kind) ? 'wait' : 'gone'
}

export type AddressLookup = {
  /**
   * The environment to open the address in, for the moment before the
   * selection has moved there. Worked out while rendering: an effect would
   * first let the selected environment decide that the address does not exist.
   */
  owner: string | null
  /**
   * `searching`: someone may yet have it. `offline`: nobody who can say has
   * it, and `offline` lists who cannot say. `absent`: nobody has it.
   */
  status: 'settled' | 'searching' | 'offline' | 'absent'
  offline: readonly string[]
  /** The environment on screen answered that it does not have this session. */
  reportAbsent: (sessionId: string) => void
}

const NO_LABELS: readonly string[] = []
const NO_ONE: ReadonlySet<string> = new Set()
const NOTHING = () => undefined

const AddressLookupContext = createContext<AddressLookup>({
  owner: null,
  status: 'settled',
  offline: NO_LABELS,
  reportAbsent: NOTHING,
})

export const AddressLookupProvider = AddressLookupContext.Provider

export function useAddressLookup() {
  return useContext(AddressLookupContext)
}

function keyOf(address: Address | null) {
  return address && `${address.kind}:${address.id}`
}

/**
 * Finds the environment an address belongs to. Opening a session or draft
 * moves the selection there, which is what makes the page that environment's.
 * That happens once per address: choosing another environment while on it is a
 * person's choice, and the address must not pull them back.
 *
 * Environments are checked in the order that costs least: what is already
 * loaded, cached ones included, needs no request. Only a session past what any
 * of them has loaded is asked for, once the environment on screen has said no,
 * because a session it is creating this moment has no row yet.
 */
export function useFindAddress(address: Address | null): AddressLookup {
  const { clients, everyCacheRead } = useEnvironmentClients()
  const { links, environments, selectedId, followEnvironment } = useConnection()
  const key = keyOf(address)

  const [settled, setSettled] = useState<string | null>(null)
  if (settled !== null && settled !== key) setSettled(null)
  const searching = address !== null && settled !== key

  const [answers, setAnswers] = useState<{ key: string | null; from: ReadonlySet<string> }>({
    key: null,
    from: NO_ONE,
  })
  const absent = answers.key === key ? answers.from : NO_ONE
  const noteAbsent = useCallback((answered: string, environmentId: string) => {
    setAnswers((current) => ({
      key: answered,
      from: new Set(current.key === answered ? current.from : []).add(environmentId),
    }))
  }, [])

  // The selected environment first, so it decides a match it shares.
  const ordered = useMemo(
    () =>
      [...links].sort(
        (a, b) =>
          Number(b.environmentId === selectedId) - Number(a.environmentId === selectedId),
      ),
    [links, selectedId],
  )
  const readOwner = useCallback(
    () =>
      (address &&
        ordered.find(({ environmentId }) => {
          const state = clients[environmentId]?.getState()
          return state && holds(state, address)
        })?.environmentId) ||
      null,
    [address, clients, ordered],
  )
  const readStandings = useCallback(
    () =>
      address
        ? ordered
            .map((link) =>
              standingOf(link, clients[link.environmentId], address, absent),
            )
            .join(' ')
        : '',
    [absent, address, clients, ordered],
  )
  // The stores tell of every event; these reads say when that matters here.
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!searching) return NOTHING
      const leave = Object.values(clients).map((client) => client.subscribe(listener))
      return () => {
        for (const stop of leave) stop()
      }
    },
    [clients, searching],
  )
  const owner = useSyncExternalStore(subscribe, readOwner, readOwner)
  const standings = useSyncExternalStore(subscribe, readStandings, readStandings)

  const pendingOwner = searching ? owner : null
  useEffect(() => {
    if (!pendingOwner) return
    setSettled(key)
    if (pendingOwner !== selectedId) followEnvironment(pendingOwner)
  }, [followEnvironment, key, pendingOwner, selectedId])

  // Asked once each. A question that went unanswered because the socket went
  // down is asked again when it is back.
  const asked = useRef<{ key: string | null; from: Set<string> }>({ key: null, from: new Set() })
  const currentKey = useRef(key)
  useEffect(() => {
    currentKey.current = key
  }, [key])
  useEffect(() => {
    if (!searching || !address || pendingOwner) return
    if (address.kind !== 'session') return
    const standing = (link: EnvironmentLink) =>
      standingOf(link, clients[link.environmentId], address, absent)
    const shown = links.find((link) => link.environmentId === selectedId)
    if (shown && standing(shown) === 'ask') return
    if (asked.current.key !== key) asked.current = { key, from: new Set() }
    const from = asked.current.from
    for (const link of links) {
      const client = clients[link.environmentId]
      if (!client || standing(link) !== 'ask' || from.has(link.environmentId)) continue
      from.add(link.environmentId)
      const { id } = address
      client.commands.openSession(id).then(
        () => {
          // Opening selects it there. Nobody is looking any more, and left
          // selected it would be opened again after every reconnect.
          if (currentKey.current !== key && client.getState().activeSessionId === id) {
            client.setActiveSession(null)
          }
        },
        (error: unknown) => {
          if (isEnvironmentClientError(error) && error.code === 'unavailable') {
            from.delete(link.environmentId)
            return
          }
          noteAbsent(key!, link.environmentId)
        },
      )
    }
  }, [
    absent,
    address,
    clients,
    key,
    links,
    noteAbsent,
    pendingOwner,
    searching,
    selectedId,
    standings,
  ])

  const reportAbsent = useCallback(
    (sessionId: string) => {
      if (selectedId) noteAbsent(`session:${sessionId}`, selectedId)
    },
    [noteAbsent, selectedId],
  )

  return useMemo(() => {
    const result = { owner: pendingOwner, offline: NO_LABELS, reportAbsent }
    if (!address) return { ...result, status: 'settled' }
    // Someone chose to be somewhere else: only that environment's word counts.
    if (!searching) {
      const said = selectedId !== null && absent.has(selectedId)
      return { ...result, status: said ? 'absent' : 'settled' }
    }
    if (owner) return { ...result, status: 'settled' }
    const each = standings.split(' ')
    if (!everyCacheRead || each.includes('ask') || each.includes('wait')) {
      return { ...result, status: 'searching' }
    }
    const gone = ordered.filter((_, index) => each[index] === 'gone')
    if (address.kind === 'draft' || gone.length === 0) return { ...result, status: 'absent' }
    const label = ({ environmentId }: EnvironmentLink) =>
      environments.find((item) => item.environmentId === environmentId)?.label ?? environmentId
    return { ...result, status: 'offline', offline: gone.map(label) }
  }, [
    absent,
    address,
    environments,
    everyCacheRead,
    ordered,
    owner,
    pendingOwner,
    reportAbsent,
    searching,
    selectedId,
    standings,
  ]) as AddressLookup
}
