import { useLocalSearchParams } from 'expo-router'

import { DraftPagePlaceholder } from '../../ui/DraftPagePlaceholder'

/** A draft opened from its row on the home's Drafts tab. */
export default function DraftPage() {
  const { draftId } = useLocalSearchParams<{ draftId: string }>()
  return <DraftPagePlaceholder draftId={draftId} />
}
