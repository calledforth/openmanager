import { useEffect, useState } from 'react'
import { Keyboard } from 'react-native'

/**
 * How tall the keyboard stands over the window; zero while it is down. Read
 * once per show and hide, never per frame.
 */
export function useKeyboardHeight(): number {
  const [height, setHeight] = useState(0)
  useEffect(() => {
    const shown = Keyboard.addListener('keyboardDidShow', (event) =>
      setHeight(event.endCoordinates.height),
    )
    const hidden = Keyboard.addListener('keyboardDidHide', () => setHeight(0))
    return () => {
      shown.remove()
      hidden.remove()
    }
  }, [])
  return height
}
