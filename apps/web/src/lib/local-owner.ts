import { environmentLocalOwnerUrl, isLoopbackEnvironmentEndpoint, parseEnvironmentCredential } from './environment-store'

const OWNER_CREDENTIAL_PATTERN = /^omc1\.[A-Za-z0-9_-]{43}$/
const LOCAL_OWNER_CLAIM_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/
export const LOCAL_OWNER_CLAIM_HEADER = 'x-openmanager-local-owner'

export type LocalOwnerClaim = {
  environmentId: string
  label?: string
  credential: string
  grant: string[]
  kind: 'owner'
}

function parseLocalOwnerClaim(body: unknown): LocalOwnerClaim | undefined {
  if (!body || typeof body !== 'object') return undefined
  const record = body as Record<string, unknown>
  if (record.kind !== 'owner') return undefined
  if (typeof record.environmentId !== 'string' || !record.environmentId.trim()) return undefined
  const credential = parseEnvironmentCredential(
    typeof record.credential === 'string' ? record.credential : '',
  )
  if (!OWNER_CREDENTIAL_PATTERN.test(credential)) return undefined
  const grant = Array.isArray(record.grant)
    ? record.grant.filter((item): item is string => typeof item === 'string')
    : []
  return {
    environmentId: record.environmentId.trim(),
    label:
      typeof record.label === 'string' && record.label.trim() ? record.label.trim() : undefined,
    credential,
    grant,
    kind: 'owner',
  }
}

/**
 * Ask a loopback environment for its published owner credential. Remote
 * endpoints are not contacted: pairing is how those clients enroll. A failed
 * or ineligible claim is silent so the user can still paste a token.
 */
export async function fetchLocalOwner(
  endpoint: string,
  claimKey = import.meta.env.VITE_OPENMANAGER_LOCAL_OWNER_CLAIM_KEY,
): Promise<LocalOwnerClaim | undefined> {
  const validatedClaimKey = claimKey ?? ''
  if (
    !isLoopbackEnvironmentEndpoint(endpoint) ||
    !LOCAL_OWNER_CLAIM_KEY_PATTERN.test(validatedClaimKey)
  ) {
    return undefined
  }
  let response: Response
  try {
    response = await fetch(environmentLocalOwnerUrl(endpoint), {
      headers: {
        accept: 'application/json',
        [LOCAL_OWNER_CLAIM_HEADER]: validatedClaimKey,
      },
    })
  } catch {
    return undefined
  }
  if (!response.ok) return undefined
  try {
    return parseLocalOwnerClaim(await response.json())
  } catch {
    return undefined
  }
}

export { parseLocalOwnerClaim }
