import { useLocalSearchParams } from 'expo-router'

import { LegacyRedirect } from '../../environment/legacy-route'
import { BLANK_DRAFT } from '../../environment/landing-route'
import { useHomeSource } from '../../home/source'
import { DraftPagePlaceholder } from '../../ui/DraftPagePlaceholder'
import { FixtureDraftPage } from '../../draft/FixtureDraftPage'
import { FIXTURE_ENVIRONMENT } from '../../home/fixture'

/**
 * A new-session address from before environments were part of it
 * (`/draft/new`, `/draft/<id>`). It moves to the address of the environment
 * that holds the draft, or for a blank page the one new sessions go to. The
 * sample home's cards open here too.
 */
export default function LegacyDraftRoute() {
  const { draftId, composer } = useLocalSearchParams<{ draftId: string; composer?: string }>()
  const { kind } = useHomeSource()
  const id = String(draftId ?? BLANK_DRAFT)
  const shown = id === BLANK_DRAFT ? undefined : id
  const placeholder = <DraftPagePlaceholder draftId={shown} />
  // The sample home's blank page: the first sample environment's.
  if (kind === 'fixture') {
    return shown ? (
      placeholder
    ) : (
      <FixtureDraftPage environmentId={FIXTURE_ENVIRONMENT.environmentId} opened={composer} />
    )
  }
  return <LegacyRedirect kind="draft" id={id} waiting={placeholder} none={placeholder} />
}
