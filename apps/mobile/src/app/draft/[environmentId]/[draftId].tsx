import { useLocalSearchParams } from 'expo-router'

import { DraftPage } from '../../../draft/DraftPage'
import { EnvironmentPage } from '../../../environment/PhoneEnvironmentProvider'
import { BLANK_DRAFT } from '../../../environment/landing-route'
import { useHomeSource } from '../../../home/source'
import { DraftPagePlaceholder } from '../../../ui/DraftPagePlaceholder'

/**
 * A new session in one environment: the blank page the compose button opens
 * (`/draft/<environment>/new`), or a draft's own page
 * (`/draft/<environment>/<id>`), from its card on the home or from a blank
 * page's first text. One route for both, so the blank page becomes its
 * draft's in place, keyboard up. Which draft it shows is that environment's
 * shared session state's to say, from the address.
 */
export default function DraftScreen() {
  const { environmentId, draftId } = useLocalSearchParams<{
    environmentId: string
    draftId: string
  }>()
  const { kind } = useHomeSource()
  const shown = draftId === BLANK_DRAFT ? undefined : draftId
  if (kind === 'fixture') return <DraftPagePlaceholder draftId={shown} />
  const environment = String(environmentId ?? '')
  return (
    <EnvironmentPage
      environmentId={environment}
      fallback={<DraftPagePlaceholder draftId={shown} environmentId={environment} />}
    >
      {/* Its own page per environment: a picked environment is a new page. */}
      <DraftPage key={environment} />
    </EnvironmentPage>
  )
}
