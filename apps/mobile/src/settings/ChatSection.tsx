import { View } from 'react-native'
import { useEnterWhileRunning, type FollowUpAction } from '@openmanager/app-core/logic'

import { AppText } from '../components/ui/AppText'
import { PhoneDevice } from '../storage/PhoneDevice'
import { usePhoneTheme } from '../theme/ThemeProvider'
import { SectionLabel } from '../ui/chrome'
import { Segmented } from './Segmented'

const OPTIONS: ReadonlyArray<{ key: FollowUpAction; label: string }> = [
  { key: 'queue', label: 'Queue' },
  { key: 'steer', label: 'Steer' },
]

const EXPLAINED: Record<FollowUpAction, string> = {
  queue: 'A message sent while a turn runs waits, and runs when the turn ends.',
  steer: 'A message sent while a turn runs cuts in once the current step ends.',
}

/**
 * What Send does while a turn runs, as web's "Enter while running": queue
 * the message for the next turn, or steer it into this one. The other is a
 * long press on the send button away. Kept on this phone, as web keeps it
 * on its device: it is how this person types, not what a chat holds.
 */
export function ChatSection() {
  return (
    // Offered once the phone's storage has loaded: a choice made before would be dropped.
    <PhoneDevice hold>
      <ChatChoice />
    </PhoneDevice>
  )
}

function ChatChoice() {
  const theme = usePhoneTheme()
  const [value, setValue] = useEnterWhileRunning()
  return (
    <>
      <SectionLabel>Chat</SectionLabel>
      <View style={{ paddingHorizontal: 12, paddingTop: 2, paddingBottom: 6, gap: 8 }}>
        <AppText variant="text-13-regular" style={{ color: theme.fg, paddingHorizontal: 2 }}>
          While a turn runs, Send
        </AppText>
        <Segmented
          label="While a turn runs, Send"
          options={OPTIONS}
          value={value}
          onChange={setValue}
        />
        <AppText variant="text-12-regular" style={{ color: theme.muted, paddingHorizontal: 2 }}>
          {EXPLAINED[value]} Hold the send button for the other.
        </AppText>
      </View>
    </>
  )
}
