import { useEffect, useState } from 'react'
import { AppState, Keyboard } from 'react-native'

/**
 * How tall the keyboard stands over the window; zero while it is down. Read
 * once per show and hide, never per frame.
 */
export function useKeyboardHeight(): number {
  const [height, setHeight] = useState(() =>
    Keyboard.isVisible() ? (Keyboard.metrics()?.height ?? 0) : 0,
  )
  useEffect(() => {
    // A keyboard that went down between the first render and this effect.
    if (!Keyboard.isVisible()) setHeight(0)
    const shown = Keyboard.addListener('keyboardDidShow', (event) =>
      setHeight(event.endCoordinates.height),
    )
    const hidden = Keyboard.addListener('keyboardDidHide', () => setHeight(0))
    // The app going to the background takes the keyboard with it, and Android
    // does not always say so: back in front, it is read again.
    const app = AppState.addEventListener('change', (next) => {
      if (next === 'active' && !Keyboard.isVisible()) setHeight(0)
    })
    return () => {
      shown.remove()
      hidden.remove()
      app.remove()
    }
  }, [])
  return height
}
