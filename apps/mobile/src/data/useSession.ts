import { api } from '@openmanager/convex/_generated/api'
import { useQuery } from 'convex/react'

// Session detail + reachability. A session whose `clientId` is unset can never
// be reached from mobile (a submitted job would target the mobile client
// itself), so the UI must disable the composer/abort for it — see plan §3.

export function useSession(externalId: string | null | undefined) {
  const session = useQuery(
    api.sessions.getByExternalId,
    externalId ? { externalId } : 'skip',
  )

  return {
    session: session ?? null,
    isReachable: !!session?.clientId,
    isLoading: externalId ? session === undefined : false,
  }
}
