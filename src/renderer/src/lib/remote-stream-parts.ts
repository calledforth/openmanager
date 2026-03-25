export interface StreamMessagePart {
  type: string
  id: string
  __ordinal?: number
  [key: string]: unknown
}

export interface PartOrdinalState {
  ordinals: Map<string, number>
  nextOrdinal: number
}

export function createPartOrdinalState(): PartOrdinalState {
  return {
    ordinals: new Map<string, number>(),
    nextOrdinal: 0,
  }
}

export function assignPartOrdinal(state: PartOrdinalState, partId: string): number {
  const existing = state.ordinals.get(partId)
  if (typeof existing === 'number') return existing
  const next = state.nextOrdinal
  state.nextOrdinal += 1
  state.ordinals.set(partId, next)
  return next
}

export function upsertRemotePart(
  parts: StreamMessagePart[],
  part: StreamMessagePart,
): StreamMessagePart[] {
  const idx = parts.findIndex((entry) => entry.id === part.id)
  if (idx === -1) return [...parts, part]
  const next = [...parts]
  next[idx] = part
  return next
}

export function sortRemoteParts(parts: StreamMessagePart[]): StreamMessagePart[] {
  return [...parts].sort((left, right) => {
    const leftOrdinal =
      typeof left.__ordinal === 'number' ? left.__ordinal : Number.MAX_SAFE_INTEGER
    const rightOrdinal =
      typeof right.__ordinal === 'number' ? right.__ordinal : Number.MAX_SAFE_INTEGER
    if (leftOrdinal !== rightOrdinal) return leftOrdinal - rightOrdinal
    return left.id.localeCompare(right.id)
  })
}

export function normalizeSnapshotParts(
  parts: StreamMessagePart[] | undefined,
  state: PartOrdinalState,
): StreamMessagePart[] | undefined {
  if (!parts || parts.length === 0) return undefined
  const mapped = parts.map((part) => ({
    ...part,
    __ordinal: assignPartOrdinal(state, part.id),
  }))
  return sortRemoteParts(mapped)
}

export function applyPartUpdate(
  parts: StreamMessagePart[] | undefined,
  part: StreamMessagePart,
  state: PartOrdinalState,
): StreamMessagePart[] {
  const withOrdinal = {
    ...part,
    __ordinal: assignPartOrdinal(state, part.id),
  }
  return sortRemoteParts(upsertRemotePart(parts ?? [], withOrdinal))
}
