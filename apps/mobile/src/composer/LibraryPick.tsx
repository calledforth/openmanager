import { launchImageLibraryAsync, type ImagePickerAsset } from 'expo-image-picker'
import { useEffect } from 'react'

import { useCapture } from './capture'
import type { CapturedPhoto } from './model'

/**
 * What the picker handed back, as the composer attaches a photo; null for
 * nothing picked. The picker re-encodes at the quality asked for, writing
 * anything but a PNG as JPEG bytes while it keeps the original's type and
 * name (a WebP comes back as JPEG under `image/webp`), so the type and name
 * are those of the bytes.
 */
export function photoFromAsset(asset: ImagePickerAsset | undefined): CapturedPhoto | null {
  if (!asset?.uri) return null
  const png = asset.mimeType === 'image/png'
  const stem = asset.fileName
    ? asset.fileName.replace(/\.[^.]*$/, '')
    : `Photo ${new Date().toISOString()}`
  return {
    uri: asset.uri,
    name: `${stem}.${png ? 'png' : 'jpg'}`,
    mimeType: png ? 'image/png' : 'image/jpeg',
  }
}

/** One photo from the system's photo picker (no permission asked on Android 13+ or iOS 14+). */
export async function pickFromLibrary(): Promise<CapturedPhoto | null> {
  const result = await launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsMultipleSelection: false,
    quality: 0.8,
    exif: false,
  })
  return result.canceled ? null : photoFromAsset(result.assets[0])
}

/** Nothing picked: the picker closed with no photo. */
const NOTHING = new Error('No photo was picked.')

/**
 * A photo for the composer, from the photo library: the system's picker,
 * opened the moment this mounts. It is the camera's shutter (`useCapture`)
 * with the picker for a lens, so it is bound the same way: a photo picked
 * while it is open is attached and closes it; once it has closed (the
 * composer collapsed, the page left), a photo still on its way lands nowhere.
 * Nothing picked, or a picker that failed, just closes it.
 */
export function LibraryPick({
  onPhoto,
  onClose,
  pick = pickFromLibrary,
}: {
  onPhoto: (photo: CapturedPhoto) => void
  onClose: () => void
  pick?: () => Promise<CapturedPhoto | null>
}) {
  const take = async () => {
    const photo = await pick()
    if (!photo) throw NOTHING
    return photo
  }
  const { shoot, close, failure } = useCapture({ take, onPhoto, onClose })
  useEffect(() => {
    void shoot()
    // Once, on opening: the picker is the whole of it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    if (failure !== null) close()
  }, [close, failure])
  return null
}
