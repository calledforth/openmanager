import { useCallback, useEffect, useRef, useState } from 'react'

import type { CapturedPhoto } from './model'

/**
 * The camera's shutter, as a hook: a shot taken while the camera is open is
 * attached and closes it; once it has closed (Close, Back, or unmounted), a
 * shot still on its way lands nowhere and closes nothing, so it can neither
 * attach a photo nor close a sheet opened since.
 */
export function useCapture({
  take,
  onPhoto,
  onClose,
}: {
  take: () => Promise<CapturedPhoto>
  onPhoto: (photo: CapturedPhoto) => void
  onClose: () => void
}) {
  const open = useRef(true)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  useEffect(
    () => () => {
      open.current = false
    },
    [],
  )
  const close = useCallback(() => {
    if (!open.current) return
    open.current = false
    onClose()
  }, [onClose])
  const shoot = useCallback(async () => {
    if (!open.current || busy) return
    setBusy(true)
    setFailure(null)
    try {
      const photo = await take()
      if (!open.current) return
      open.current = false
      onPhoto(photo)
      onClose()
    } catch (error) {
      if (open.current)
        setFailure(error instanceof Error ? error.message : 'The photo was not taken.')
    } finally {
      if (open.current) setBusy(false)
    }
  }, [busy, onClose, onPhoto, take])
  return { shoot, close, busy, failure }
}
