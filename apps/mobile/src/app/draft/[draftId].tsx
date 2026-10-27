import { useLocalSearchParams } from 'expo-router'
import { useEnvironmentClientOptional } from '@openmanager/app-core/logic'

import { DraftPage } from '../../draft/DraftPage'
import { BLANK_DRAFT } from '../../environment/landing-route'
import { useHomeSource } from '../../home/source'
import { DraftPagePlaceholder } from '../../ui/DraftPagePlaceholder'

/**
 * A new session: the blank page the compose button opens (`/draft/new`), or
 * a draft's own page (`/draft/<id>`), from its row on the home's Drafts tab
 * or from a blank page's first text. One route for both, so the blank page
 * becomes its draft's in place, keyboard up. Which draft it shows is the
 * shared session state's to say, from the address.
 */
export default function DraftScreen() {
  const { draftId } = useLocalSearchParams<{ draftId: string }>()
  const { kind } = useHomeSource()
  const client = useEnvironmentClientOptional()
  if (kind === 'fixture' || !client) {
    return <DraftPagePlaceholder draftId={draftId === BLANK_DRAFT ? undefined : draftId} />
  }
  return <DraftPage />
}
