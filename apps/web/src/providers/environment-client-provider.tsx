import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  createWebSocketEnvironmentClient,
  type EnvironmentClient,
} from '@openmanager/environment-client'
import { EnvironmentClientProvider } from '@openmanager/app-core/providers/environment-client'
import { environmentSocketUrl } from '../lib/environment-socket'
import { routeHealthFromConnection } from '../lib/route-health'
import { createEnvironmentCache, writeEnvironmentCache } from '../lib/environment-cache'
import { useConnection } from './connection-provider'
import type { ConnectionUiState } from '../lib/connection-state'
import type { EnvironmentLink } from '../lib/environment-link'

/** States that waiting does not fix. The client goes; a person decides what next. */
const NEEDS_A_PERSON: ReadonlySet<ConnectionUiState['kind']> = new Set([
  'no_environment',
  'confirm_route',
  'unauthorized',
  'incompatible_protocol',
])

/** How long changes wait before they are saved to this browser's cache. */
const CACHE_SAVE_DELAY_MS = 250
/**
 * The same for an environment not on screen. A save copies the whole state on
 * the main thread, and several busy environments would otherwise add that up.
 * Nobody is typing there, and what a reload loses comes back from the
 * environment.
 */
const BACKGROUND_CACHE_SAVE_DELAY_MS = 2000

type EnvironmentCache = ReturnType<typeof createEnvironmentCache>
type Connection = ReturnType<typeof useConnection>

type EnvironmentClients = {
  /** Every environment's client that may be shown, by environment ID. */
  clients: Readonly<Record<string, EnvironmentClient>>
  /**
   * What this browser kept of every saved environment has been read, at least
   * once. Before that, not finding something in them means nothing.
   */
  everyCacheRead: boolean
}

const EnvironmentClientsContext = createContext<EnvironmentClients>({
  clients: {},
  everyCacheRead: true,
})

export function useEnvironmentClients() {
  return useContext(EnvironmentClientsContext)
}

/**
 * A client that has not got through yet, as the page may see it: the same
 * cached state and drafts, and nothing that reaches the route. The artifact
 * calls are left out because they go over HTTP with the token, and a route
 * that has not answered as this environment must never be sent that.
 */
function cachedView(client: EnvironmentClient): EnvironmentClient {
  return { ...client, fetchArtifact: undefined, uploadArtifact: undefined }
}

/**
 * Owns one saved environment's client, from its cached state to its socket.
 * The client exists as soon as the cache is read, so an environment that
 * cannot be reached still shows what this browser kept of it, but it only
 * dials once bootstrap has proven the route answers as this environment. It is
 * replaced whenever the route or credential changes. Identity never changes
 * with the endpoint: a different route to the same environment gets a new
 * client on the same store, so sessions and the credential carry over.
 */
function EnvironmentHost({
  link,
  onScreen,
  cache,
  createClient,
  reportRouteHealth,
  forgetSocket,
  publish,
  noteCacheRead,
}: {
  link: EnvironmentLink
  onScreen: boolean
  cache: EnvironmentCache
  createClient: typeof createWebSocketEnvironmentClient
  reportRouteHealth: Connection['reportRouteHealth']
  forgetSocket: Connection['forgetSocket']
  publish: (environmentId: string, client: EnvironmentClient | null) => void
  noteCacheRead: (environmentId: string) => void
}) {
  const { environmentId, endpoint, routeVerified, wrongEnvironment, attempt } = link
  const credential = link.credential || undefined
  const needsPerson = NEEDS_A_PERSON.has(link.ui.kind)
  // A drop, an offline blip, or a route that is slow to answer must not tear
  // the client down: the socket's own backoff loop is what recovers the
  // session, and disposing would drop the store and unmount the page with it.
  // Only a different route or token (the effect's keys), or a failure that
  // needs a person, replaces the client.
  // A route that answered as another environment never gets a socket, even
  // when the device being offline outranks that in the interface: the socket
  // would hand this environment's token to whatever answered.
  const alive = !needsPerson && !wrongEnvironment

  // The client is created inside the effect rather than memoized so that
  // StrictMode's setup → cleanup → setup replay (and any real remount) gets a
  // fresh instance; a disposed client ignores connect() for good.
  const [client, setClient] = useState<EnvironmentClient | null>(null)
  const onScreenRef = useRef(onScreen)
  const tokenRefusedRef = useRef(link.tokenRefused)
  useEffect(() => {
    onScreenRef.current = onScreen
    tokenRefusedRef.current = link.tokenRefused
  }, [link.tokenRefused, onScreen])
  useEffect(() => {
    if (needsPerson) {
      // Hidden, so there is nothing of it to read.
      noteCacheRead(environmentId)
      return
    }
    let cancelled = false
    let release: (() => void) | undefined
    void cache.getStore(environmentId).then((store) => {
      if (cancelled) return
      const next = createClient({
        url: environmentSocketUrl(endpoint),
        credential,
        environmentId,
        store,
      })
      const cached = cachedView(next)
      let authorized = false
      let shown: EnvironmentClient | null | undefined
      const show = () => {
        const { connection, environment } = next.getState()
        const refused = connection.failure?.code === 'auth'
        if (connection.phase === 'connected') authorized = true
        if (refused) authorized = false
        const hidden = refused || tokenRefusedRef.current
        // What this browser kept is shown until the environment refuses this
        // client. With nothing kept there is nothing to show yet.
        const visible = authorized ? next : environment && !hidden ? cached : null
        if (visible === shown) return
        shown = visible
        publish(environmentId, visible)
      }
      let saveTimer: ReturnType<typeof setTimeout> | undefined
      const save = () => {
        saveTimer = undefined
        void writeEnvironmentCache(environmentId, store.getServerState())
      }
      const unsubscribeCache = store.subscribe(() => {
        if (saveTimer !== undefined) return
        const delay = onScreenRef.current ? CACHE_SAVE_DELAY_MS : BACKGROUND_CACHE_SAVE_DELAY_MS
        saveTimer = setTimeout(save, delay)
      })
      // A reload inside the pause would lose the last keystrokes of a draft
      // that has not reached the environment yet.
      const saveNow = () => {
        if (saveTimer === undefined) return
        clearTimeout(saveTimer)
        save()
      }
      window.addEventListener('pagehide', saveNow)
      // What the socket learns is about the route it dialled, so it is filed on
      // that route. The store notifies on every event; only a changed connection
      // is worth reading.
      let seen: unknown
      const unsubscribe = next.subscribe(() => {
        show()
        const { connection } = next.getState()
        if (connection === seen) return
        seen = connection
        const report = routeHealthFromConnection(connection)
        if (report) reportRouteHealth(environmentId, endpoint, report, credential ?? '')
      })
      show()
      noteCacheRead(environmentId)
      setClient(next)
      release = () => {
        unsubscribe()
        // Whatever this socket said about the route stops being true now. Left
        // on record, a later return to the route would read as connected
        // before anything had answered there.
        forgetSocket(environmentId, endpoint)
        next.dispose()
        unsubscribeCache()
        window.removeEventListener('pagehide', saveNow)
        if (saveTimer !== undefined) clearTimeout(saveTimer)
        save()
        setClient((current) => (current === next ? null : current))
      }
    })
    return () => {
      cancelled = true
      release?.()
    }
  }, [
    cache,
    createClient,
    credential,
    endpoint,
    environmentId,
    forgetSocket,
    needsPerson,
    noteCacheRead,
    publish,
    reportRouteHealth,
    wrongEnvironment,
  ])

  // The page keeps what it has while a replacement is on its way; these two
  // are the cases where nothing takes its place.
  useEffect(() => {
    if (needsPerson) publish(environmentId, null)
  }, [environmentId, needsPerson, publish])
  useEffect(() => () => publish(environmentId, null), [environmentId, publish])

  // Staying alive and dialling are different permissions. A client that has
  // dialled rides out a drop on its own backoff, but dialling is only allowed
  // on an answer to the latest question: offline says nothing about what is at
  // the address, and the socket upgrade carries the environment's token. So
  // asking again, or the network coming back, dials as soon as that answer is
  // in rather than at the end of the backoff window. connect() on a live client
  // is a no-op. This is the only place a socket is opened.
  useEffect(() => {
    if (alive && routeVerified) client?.connect()
  }, [alive, attempt, client, routeVerified])

  return null
}

/**
 * Keeps a client for every saved environment and hands the selected one to the
 * page. Each environment connects on its own, whichever one is on screen.
 */
export function WebEnvironmentClientProvider({
  children,
  createClient = createWebSocketEnvironmentClient,
}: {
  children: ReactNode
  createClient?: typeof createWebSocketEnvironmentClient
}) {
  const { environment, links, reportRouteHealth, forgetSocket } = useConnection()
  const cache = useRef<EnvironmentCache | null>(null)
  if (!cache.current) cache.current = createEnvironmentCache()
  const [clients, setClients] = useState<Readonly<Record<string, EnvironmentClient>>>({})
  const publish = useCallback((environmentId: string, client: EnvironmentClient | null) => {
    setClients((current) => {
      if ((current[environmentId] ?? null) === client) return current
      const next = { ...current }
      if (client) next[environmentId] = client
      else delete next[environmentId]
      return next
    })
  }, [])
  const [cachesRead, setCachesRead] = useState<ReadonlySet<string>>(() => new Set())
  const noteCacheRead = useCallback((environmentId: string) => {
    setCachesRead((current) =>
      current.has(environmentId) ? current : new Set(current).add(environmentId),
    )
  }, [])
  // Once. An environment added later must not put what is open on hold.
  const [everyCacheRead, setEveryCacheRead] = useState(false)
  if (!everyCacheRead && links.every((link) => cachesRead.has(link.environmentId))) {
    setEveryCacheRead(true)
  }
  const allClients = useMemo(() => ({ clients, everyCacheRead }), [clients, everyCacheRead])
  // Identity comes only from the selection's environment ID, which a connect
  // has none of until the address has answered.
  const shownId = environment.status === 'selected' ? environment.environmentId : undefined
  return (
    <>
      {links.map((link) => (
        <EnvironmentHost
          key={link.environmentId}
          link={link}
          onScreen={link.environmentId === shownId}
          cache={cache.current!}
          createClient={createClient}
          reportRouteHealth={reportRouteHealth}
          forgetSocket={forgetSocket}
          publish={publish}
          noteCacheRead={noteCacheRead}
        />
      ))}
      <EnvironmentClientsContext.Provider value={allClients}>
        <EnvironmentClientProvider client={(shownId && clients[shownId]) || null}>
          {children}
        </EnvironmentClientProvider>
      </EnvironmentClientsContext.Provider>
    </>
  )
}
