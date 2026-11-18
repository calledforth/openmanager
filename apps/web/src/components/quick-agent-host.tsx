import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
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
import { useAddressLookup } from '../providers/address-environment'
import { AddWorkspaceDialog } from './add-workspace-dialog'

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
  const { prefer } = useAddressLookup()
  const live = useRef({ clients, prefer })
  useLayoutEffect(() => {
    live.current = { clients, prefer }
  }, [clients, prefer])
  // Add project from a card on another environment: the dialog is that
  // environment's, and lives here, as the card closes when it opens.
  const [addingTo, setAddingTo] = useState<string | null>(null)
  const addingClient = addingTo ? clients[addingTo] : undefined

  const environments = useMemo<QuickAgentEnvironments | null>(() => {
    if (!choice?.carry) return null
    const { carry, choose } = choice
    return {
      environments: choice.environments,
      clientOf: (environmentId) => live.current.clients[environmentId],
      carry,
      // An address does not say whose it is, and ids are only unique within
      // one environment: the card's word comes first, as a sidebar card's does.
      openDraft: (environmentId, draftId) => {
        live.current.prefer({ kind: 'draft', id: draftId }, environmentId)
        void navigate({ to: '/drafts/$draftId', params: { draftId } })
      },
      openSession: (environmentId, sessionId) => {
        live.current.prefer({ kind: 'session', id: sessionId }, environmentId)
        void navigate({ to: '/sessions/$sessionId', params: { sessionId } })
      },
      openNewSession: (environmentId, workspaceId) => void choose(environmentId, null, workspaceId),
    }
  }, [choice, navigate])

  return (
    <QuickAgentHost environments={environments}>
      {children}
      <QuickAgentElsewhere shellEnvironmentId={shellEnvironmentId} onAddWorkspace={setAddingTo} />
      {addingTo && addingClient ? (
        <AddWorkspaceDialog
          key={addingTo}
          client={addingClient}
          open
          onClose={() => setAddingTo(null)}
          // As on the page's own environment: a project just added opens a
          // new agent in it, there.
          onAdded={(workspaceId) => {
            setAddingTo(null)
            choice?.choose(addingTo, null, workspaceId)
          }}
        />
      ) : null}
    </QuickAgentHost>
  )
}

/**
 * The palette for a card whose draft is kept on an environment the page is
 * not on: that environment's providers, with no page of their own. Nothing
 * here navigates or opens a session; the card goes through the address, and
 * Add project through the host's dialog for that environment.
 */
function QuickAgentElsewhere({
  shellEnvironmentId,
  onAddWorkspace,
}: {
  shellEnvironmentId: string | null
  onAddWorkspace: (environmentId: string) => void
}) {
  const open = useQuickAgentOpen()
  const { clients } = useEnvironmentClients()
  const environmentId = open?.environmentId
  const addWorkspace = useCallback(async () => {
    if (environmentId) onAddWorkspace(environmentId)
  }, [environmentId, onAddWorkspace])
  if (!environmentId || environmentId === shellEnvironmentId) return null
  const client = clients[environmentId]
  if (!client) return null
  return (
    <EnvironmentClientProvider key={environmentId} client={client}>
      <EnvironmentApplicationProviders environmentId={environmentId} addWorkspace={addWorkspace}>
        <QuickAgentPalette environmentId={environmentId} primary={false} />
      </EnvironmentApplicationProviders>
    </EnvironmentClientProvider>
  )
}
