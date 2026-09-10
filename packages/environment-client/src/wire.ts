import { ProofResponseSchemas, SessionSchema, WorkspaceSchema } from '@openmanager/protocol'
import { z } from 'zod'
import type { EnvironmentCommandName } from './types'

/**
 * Command name on the wire for each client command. Names the protocol has
 * not defined yet are provisional; an environment that does not advertise them
 * in its handshake capabilities rejects with `capability_missing` before any
 * bytes are sent. Server-side work is tracked in CAL-50 (workspaces) and
 * CAL-58 (session rename/delete).
 */
export const WIRE_COMMANDS = {
  getEnvironment: 'environment.get',
  listWorkspaces: 'workspace.list',
  addWorkspace: 'workspace.add',
  removeWorkspace: 'workspace.remove',
  listSessions: 'session.list',
  createSession: 'session.create',
  openSession: 'session.open',
  renameSession: 'session.rename',
  deleteSession: 'session.delete',
  sendTurn: 'turn.send',
  interruptTurn: 'turn.interrupt',
  respondToInteraction: 'interaction.respond',
} as const satisfies Record<EnvironmentCommandName, string>

export type WireCommandName = (typeof WIRE_COMMANDS)[EnvironmentCommandName]

const payload = <P extends z.ZodType>(schema: P) => z.object({ payload: schema })

/** Response payload schemas, including provisional ones the protocol will absorb. */
export const WIRE_RESPONSES = {
  'environment.get': payload(ProofResponseSchemas['environment.get'].shape.payload),
  'workspace.list': payload(ProofResponseSchemas['workspace.list'].shape.payload),
  'workspace.add': payload(z.object({ workspace: WorkspaceSchema })),
  'workspace.remove': payload(z.null()),
  'session.list': payload(ProofResponseSchemas['session.list'].shape.payload),
  'session.create': payload(ProofResponseSchemas['session.create'].shape.payload),
  'session.open': payload(ProofResponseSchemas['session.open'].shape.payload),
  'session.rename': payload(z.object({ session: SessionSchema })),
  'session.delete': payload(z.null()),
  'turn.send': payload(ProofResponseSchemas['turn.send'].shape.payload),
  'turn.interrupt': payload(ProofResponseSchemas['turn.interrupt'].shape.payload),
  'interaction.respond': payload(ProofResponseSchemas['interaction.respond'].shape.payload),
} as const satisfies Record<WireCommandName, z.ZodType>

export type WireResponsePayload<N extends WireCommandName> = z.infer<
  (typeof WIRE_RESPONSES)[N]
>['payload']
