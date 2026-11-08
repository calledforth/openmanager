import { useLocalSearchParams } from 'expo-router'

import { LegacyRedirect } from '../../environment/legacy-route'
import { BLANK_DRAFT } from '../../environment/landing-route'
import { useHomeSource } from '../../home/source'
import { DraftPagePlaceholder } from '../../ui/DraftPagePlaceholder'

/**
 * A new-session address from before environments were part of it
 * (`/draft/new`, `/draft/<id>`). It moves to the address of the environment
 * that holds the draft, or for a blank page the one new sessions go to. The
 * sample home's cards open here too.
 */
export default function LegacyDraftRoute() {
  const { draftId } = useLocalSearchParams<{ draftId: string }>()
  const { kind } = useHomeSource()
  const id = String(draftId ?? BLANK_DRAFT)
  const shown = id === BLANK_DRAFT ? undefined : id
  const placeholder = <DraftPagePlaceholder draftId={shown} />
  if (kind === 'fixture') return placeholder
  return <LegacyRedirect kind="draft" id={id} waiting={placeholder} none={placeholder} />
}
