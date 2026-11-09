import { Redirect } from 'expo-router'
import { useEffect, useState, type ReactNode } from 'react'

import { useHomeSource } from '../home/source'
import { draftHref, sessionHref } from './landing-route'
import { usePhoneConnection } from './PhoneEnvironmentProvider'

/**
 * How long an old address waits for the environments' listings to say whose
 * session or draft it names before it opens in the environment new sessions
 * go to. Only an address from before environments were part of addresses
 * (an older notification, a link) waits at all.
 */
export const LEGACY_WAIT_MS = 4000

export interface LegacyInputs {
  loaded: boolean
  /** Every saved environment, in the saved order. */
  environments: readonly { environmentId: string }[]
  /** The one new sessions go to. */
  selectedId: string | null
  /** The environments whose listing holds the id, in the saved order. */
  holders: readonly string[]
  /** Waited long enough: whatever is known now decides. */
  late: boolean
}

/**
 * The environment an old address (`/session/<id>`, `/draft/<id>`) opens in.
 * With one environment saved, that one, at once: the address meant nothing
 * else when it was made. With several, the one whose listing holds the id
 * (the default one first, should two hold it); until one does, `wait`, and
 * once waited long enough, the default. `null` with nothing saved. Pure.
 */
export function legacyEnvironmentOf(input: LegacyInputs): string | null | 'wait' {
  if (!input.loaded) return 'wait'
  const { environments, selectedId, holders } = input
  if (environments.length === 0) return null
  if (environments.length === 1) return environments[0]!.environmentId
  if (holders.length > 0) {
    return selectedId && holders.includes(selectedId) ? selectedId : holders[0]!
  }
  if (!input.late) return 'wait'
  return selectedId ?? environments[0]!.environmentId
}

function useLate(): boolean {
  const [late, setLate] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setLate(true), LEGACY_WAIT_MS)
    return () => clearTimeout(timer)
  }, [])
  return late
}

/**
 * An old address, moved to the address of the environment it names (in
 * place, so back goes where it went before). `waiting` shows meanwhile, and
 * `none` with nothing saved.
 */
export function LegacyRedirect({
  kind,
  id,
  waiting,
  none,
}: {
  kind: 'session' | 'draft'
  id: string
  waiting: ReactNode
  none: ReactNode
}) {
  const { loaded, environments, selectedId } = usePhoneConnection()
  const { sessions, drafts } = useHomeSource()
  const late = useLate()
  const blank = kind === 'draft' && id === 'new'
  const holders = blank
    ? []
    : (kind === 'session'
        ? sessions.filter((row) => row.externalId === id)
        : drafts.filter((row) => row.draftId === id)
      ).flatMap((row) => (row.environment ? [row.environment.environmentId] : []))
  const target = legacyEnvironmentOf({
    loaded,
    environments,
    selectedId,
    holders,
    // A blank page goes where new sessions go, without waiting.
    late: late || blank,
  })
  if (target === 'wait') return waiting
  if (target === null) return none
  return (
    <Redirect
      href={
        (kind === 'session'
          ? sessionHref(target, id)
          : draftHref(target, blank ? null : id)) as never
      }
    />
  )
}
