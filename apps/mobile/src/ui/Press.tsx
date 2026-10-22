/**
 * A Pressable whose `style` may be a function of the pressed state, as
 * React Native's is on its own. Under NativeWind's interop (which wraps
 * every Pressable on the native side) a function style is flattened away,
 * so a pressed look written that way renders with no style at all: no fill,
 * no row direction. The pressed state is held here and the style resolved
 * before it reaches the wrapped Pressable.
 */
import { useCallback, useState, type ReactNode } from 'react'
import {
  Pressable,
  type GestureResponderEvent,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native'

export type PressState = { pressed: boolean }

export function Press({
  style,
  children,
  onPressIn,
  onPressOut,
  ...props
}: Omit<PressableProps, 'style' | 'children'> & {
  style?: StyleProp<ViewStyle> | ((state: PressState) => StyleProp<ViewStyle>)
  children?: ReactNode | ((state: PressState) => ReactNode)
}) {
  const [pressed, setPressed] = useState(false)
  const pressIn = useCallback(
    (event: GestureResponderEvent) => {
      setPressed(true)
      onPressIn?.(event)
    },
    [onPressIn],
  )
  const pressOut = useCallback(
    (event: GestureResponderEvent) => {
      setPressed(false)
      onPressOut?.(event)
    },
    [onPressOut],
  )
  const state = { pressed }
  return (
    <Pressable
      {...props}
      onPressIn={pressIn}
      onPressOut={pressOut}
      style={typeof style === 'function' ? style(state) : style}
    >
      {typeof children === 'function' ? children(state) : children}
    </Pressable>
  )
}
