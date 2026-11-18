import { useLayoutEffect, useMemo, useRef, type ReactNode } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { EnvironmentClientProvider } from '@openmanager/app-core/providers/environment-client'
import { EnvironmentApplicationProviders } from '@openmanager/app-core/providers/environment-application'
import { useEnvironmentChoice } from '@openmanager/app-core/providers/sidebar-provider'
import {
  QuickAgentHost,
  QuickAgentPalette,
  useQuickAgentOpen,
  type QuickAgentEnvironments,
} from '@openmanager/app-core/components/command/QuickAgentPalette'
import { useEnvironmentClients } from '../providers/environment-client-provider'

/**
 * The quick New agent card's place above the shell, which is keyed by
 * environment: the card's draft outlives the page's environment, and moves
 * between environments while the page stays where it is.
 *
 * The page's own palette (in the shell) shows the card while its draft is
 * kept on the page's environment. Moved to another, the card is shown by a
 * palette mounted here, inside that environment's providers.
 *
 * Render under `EnvironmentChoiceHost`; with one environment saved there is
 * nothing to move between, and the card stays on the page's.
 */
export function QuickAgentWebHost({
  shellEnvironmentId,
  children,
}: {
  /** The environment whose providers the page has, which shows the card itself. */
  shellEnvironmentId: string | null
  children: ReactNode
}) {
  const choice = useEnvironmentChoice()
  const { clients } = useEnvironmentClients()
  const navigate = useNavigate()
  const clientsRef = useRef(clients)
  useLayoutEffect(() => {
    clientsRef.current = clients
  }, [clients])

  const environments = useMemo<QuickAgentEnvironments | null>(() => {
    if (!choice?.carry) return null
    const { carry, choose } = choice
    return {
      environments: choice.environments,
      clientOf: (environmentId) => clientsRef.current[environmentId],
      carry,
      // The address says whose it is: the shell follows it there.
      openDraft: (_environmentId, draftId) =>
        void navigate({ to: '/drafts/$draftId', params: { draftId } }),
      openSession: (_environmentId, sessionId) =>
        void navigate({ to: '/sessions/$sessionId', params: { sessionId } }),
      openNewSession: (environmentId, workspaceId) => void choose(environmentId, null, workspaceId),
    }
  }, [choice, navigate])

  return (
    <QuickAgentHost environments={environments}>
      {children}
      <QuickAgentElsewhere shellEnvironmentId={shellEnvironmentId} />
    </QuickAgentHost>
  )
}

/**
 * The palette for a card whose draft is kept on an environment the page is
 * not on: that environment's providers, with no page of their own. Nothing
 * here navigates or opens a session; the card goes through the address.
 */
function QuickAgentElsewhere({ shellEnvironmentId }: { shellEnvironmentId: string | null }) {
  const open = useQuickAgentOpen()
  const { clients } = useEnvironmentClients()
  const environmentId = open?.environmentId
  if (!environmentId || environmentId === shellEnvironmentId) return null
  const client = clients[environmentId]
  if (!client) return null
  return (
    <EnvironmentClientProvider key={environmentId} client={client}>
      <EnvironmentApplicationProviders environmentId={environmentId}>
        <QuickAgentPalette environmentId={environmentId} primary={false} />
      </EnvironmentApplicationProviders>
    </EnvironmentClientProvider>
  )
}
