import { View } from 'react-native'
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated'

import { AppText } from '../components/ui/AppText'
import { useTheme } from '../theme/ThemeProvider'
import { tap } from '../ui/haptics'
import { Press } from '../ui/Press'
import { MODE_OPTIONS, familySwatches } from './appearance-options'
import { Segmented } from './Segmented'

const RING_IN = FadeIn.duration(150)
const RING_OUT = FadeOut.duration(120)

/**
 * Appearance, as the mockup's Settings frame has it: the six theme families
 * as small canvas swatches with their names under them (the chosen one ringed
 * in ink), then Light / Dark / System on one segmented track. Both go
 * through the phone's theme store and stay on this phone.
 */
export function AppearanceSection() {
  const { theme, family, setFamily, mode, setMode, resolved } = useTheme()
  const swatches = familySwatches(resolved, family)
  return (
    <View>
      <View
        accessibilityRole="radiogroup"
        accessibilityLabel="Theme"
        style={{ flexDirection: 'row', gap: 10, paddingHorizontal: 12, paddingTop: 6 }}
      >
        {swatches.map((swatch) => (
          <Press
            key={swatch.id}
            accessibilityRole="radio"
            accessibilityLabel={`${swatch.label} theme`}
            accessibilityState={{ selected: swatch.selected }}
            onPress={() => {
              if (swatch.selected) return
              tap()
              setFamily(swatch.id)
            }}
            style={({ pressed }) => ({
              flex: 1,
              maxWidth: 54,
              alignItems: 'center',
              gap: 6,
              opacity: pressed ? 0.8 : 1,
            })}
          >
            <View style={{ width: '100%', aspectRatio: 1 }}>
              {swatch.selected ? (
                <Animated.View
                  entering={RING_IN}
                  exiting={RING_OUT}
                  pointerEvents="none"
                  style={{
                    position: 'absolute',
                    top: -4,
                    left: -4,
                    right: -4,
                    bottom: -4,
                    borderRadius: 18,
                    borderWidth: 2,
                    borderColor: theme.fg,
                  }}
                />
              ) : null}
              <View
                style={{
                  flex: 1,
                  borderRadius: 14,
                  backgroundColor: swatch.canvas,
                  boxShadow: `inset 0 0 0 1px ${swatch.edge}`,
                }}
              />
            </View>
            <AppText
              variant="text-11-regular"
              numberOfLines={1}
              style={{ color: swatch.selected ? theme.muted : theme.faint }}
            >
              {swatch.label}
            </AppText>
          </Press>
        ))}
      </View>
      <View style={{ paddingHorizontal: 12, paddingTop: 14, paddingBottom: 6 }}>
        <Segmented
          label="Appearance mode"
          options={MODE_OPTIONS.map((option) => ({ key: option.mode, label: option.label }))}
          value={mode}
          onChange={setMode}
        />
      </View>
    </View>
  )
}
