import { useRouter } from 'expo-router'
import { useCallback } from 'react'

/**
 * Back to where the reader came from, or to the sessions home when there is
 * nowhere to go back to (a cold deep link), so a back or close control never
 * does nothing.
 */
export function useGoBack() {
  const router = useRouter()
  return useCallback(() => {
    if (router.canGoBack()) router.back()
    else router.navigate('/')
  }, [router])
}
