import { Tabs } from 'expo-router/js-tabs'
import { useState } from 'react'

import { countNeedsYou } from '../../home/rows'
import { useHomeSource } from '../../home/source'
import { usePhoneTheme } from '../../theme/ThemeProvider'
import { createTabTargets } from '../../ui/glass-target'
import { PillNav } from '../../ui/PillNav'
import { TabTargetsContext } from '../../ui/Screen'

/**
 * The three top-level screens, one instance each: switching keeps each
 * tab's own state and scroll, re-tapping the current tab pushes nothing, and
 * Android back goes to Sessions and then out. The floating pill is the tab
 * bar; search, a session and the theme preview sit above this in the root
 * stack. The pill is drawn beside the three screens, in none of them, and
 * blurs the one in front: each screen hands its blur target to `targets`.
 */
export default function TabsLayout() {
  const theme = usePhoneTheme()
  const { sessions } = useHomeSource()
  const badge = countNeedsYou(sessions)
  const [targets] = useState(createTabTargets)
  return (
    <TabTargetsContext.Provider value={targets}>
      <Tabs
        backBehavior="firstRoute"
        tabBar={(props) => <PillNav {...props} badge={badge} targets={targets} />}
        screenOptions={{
          headerShown: false,
          // Each screen paints the canvas itself; the navigator's own
          // background (white, by default) must never show through.
          sceneStyle: { backgroundColor: theme.bg },
          animation: 'fade',
        }}
      >
        <Tabs.Screen name="index" options={{ title: 'Sessions' }} />
        <Tabs.Screen name="inbox" options={{ title: 'Inbox' }} />
        <Tabs.Screen name="settings" options={{ title: 'Settings' }} />
      </Tabs>
    </TabTargetsContext.Provider>
  )
}
