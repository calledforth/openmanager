import { Tabs } from 'expo-router/js-tabs'
import { useState } from 'react'
import { Easing } from 'react-native'

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
          // The screens cross-fade while the one coming in slides a little
          // from its side of the pill and the one leaving slides out the
          // other way, eased out, so a switch reads as one fluid move.
          animation: 'shift',
          transitionSpec: {
            animation: 'timing',
            config: { duration: 300, easing: Easing.bezier(0.22, 1, 0.36, 1) },
          },
          sceneStyleInterpolator: ({ current }) => ({
            sceneStyle: {
              opacity: current.progress.interpolate({
                inputRange: [-1, -0.4, 0, 0.4, 1],
                outputRange: [0, 0, 1, 0, 0],
              }),
              transform: [
                {
                  translateX: current.progress.interpolate({
                    inputRange: [-1, 0, 1],
                    outputRange: [-36, 0, 36],
                  }),
                },
                {
                  scale: current.progress.interpolate({
                    inputRange: [-1, 0, 1],
                    outputRange: [0.985, 1, 0.985],
                  }),
                },
              ],
            },
          }),
        }}
      >
        <Tabs.Screen name="index" options={{ title: 'Sessions' }} />
        <Tabs.Screen name="inbox" options={{ title: 'Inbox' }} />
        <Tabs.Screen name="settings" options={{ title: 'Settings' }} />
      </Tabs>
    </TabTargetsContext.Provider>
  )
}
