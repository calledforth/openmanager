import { isProviderId, type ProviderId } from '@agentpack/contract'

export function resolveSessionProviderId(value: unknown): ProviderId {
  return isProviderId(value) ? value : 'opencode'
}

export function sessionsForProvider<T extends { providerId?: unknown }>(
  sessions: T[],
  providerId: ProviderId,
): T[] {
  return sessions.filter((session) => resolveSessionProviderId(session.providerId) === providerId)
}
