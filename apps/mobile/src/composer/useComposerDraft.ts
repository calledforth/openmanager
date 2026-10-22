import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  ACCEPTED_IMAGE_TYPES,
  MAX_IMAGE_ATTACHMENTS,
  MAX_IMAGE_BYTES,
  useComposerDraftStore,
  useEnvironmentClientOptional,
  usePageExit,
  type ArtifactSource,
  type DraftImageAttachment,
  type KeptImage,
  type UploadedImageAttachment,
} from '@openmanager/app-core/logic'

import { readAsDataUri } from '../lib/dataUri'
import type { CapturedPhoto, ComposerImage } from './model'

const NO_IDS: readonly string[] = []
const NO_UPLOADS: DraftImageAttachment[] = []

/**
 * A kept image as a send names it. Only its id reaches the environment; it
 * carries no upload scope, as it is the draft's wherever the draft goes
 * (web's `keptAttachment`).
 */
const keptAttachment = (image: KeptImage): UploadedImageAttachment => ({
  id: image.artifactId,
  name: image.name,
  mimeType: '',
  size: 0,
  previewUrl: image.previewUrl ?? '',
})

const reasonOf = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback

/**
 * A photo's bytes as the shared uploader takes them: a Blob named like a
 * `File`. React Native has no `File`; the uploader reads `name`, `type` and
 * `size` and sends the Blob itself as the body.
 */
export async function photoFile(photo: CapturedPhoto, read: typeof fetch = fetch): Promise<File> {
  const blob = await (await read(photo.uri)).blob()
  Object.defineProperty(blob, 'name', { value: photo.name, configurable: true })
  if (blob.type !== photo.mimeType) {
    Object.defineProperty(blob, 'type', { value: photo.mimeType, configurable: true })
  }
  return blob as File
}

export interface DraftPorts {
  /** Store one image for the open session or draft (the shared `uploadAttachments`). */
  uploadAttachments?: (drafts: DraftImageAttachment[]) => Promise<UploadedImageAttachment[]>
  /** Send the text and images: a prompt, or a plan's change request while one is pending. */
  send: (text: string, attachments: UploadedImageAttachment[]) => Promise<void>
  /** Reads a photo's bytes; `photoFile` over `fetch` unless a test says otherwise. */
  readPhoto?: (photo: CapturedPhoto) => Promise<File>
  /**
   * The session the uploader stores under right now. A photo belongs to the
   * session it was attached in: one that finishes after the reader moved to
   * another is dropped, never stored under the new one.
   */
  uploadOwner?: () => string | null
}

/** Bytes of images another device (or an earlier visit) kept with the draft. */
function useKeptUris(sources: readonly ArtifactSource[]) {
  const client = useEnvironmentClientOptional()
  const [uris, setUris] = useState<Record<string, string | null>>({})
  const key = sources.map((source) => source.artifactId).join('\n')
  useEffect(() => {
    if (sources.length === 0) return
    const controller = new AbortController()
    for (const source of sources) {
      if (!client?.fetchArtifact) {
        setUris((current) => ({ ...current, [source.artifactId]: null }))
        continue
      }
      client
        .fetchArtifact(source, { signal: controller.signal })
        .then(readAsDataUri)
        .then(
          (uri) => {
            if (!controller.signal.aborted)
              setUris((current) => ({ ...current, [source.artifactId]: uri }))
          },
          () => {
            if (!controller.signal.aborted)
              setUris((current) => ({ ...current, [source.artifactId]: null }))
          },
        )
    }
    return () => controller.abort()
    // The sources are the same while their ids are.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, key])
  return uris
}

/**
 * The composer's draft, as web's `MessageInputView` keeps it: the text in
 * the shared draft store (the environment's draft of the session, on every
 * device), images uploaded when attached and named in the draft, a send that
 * empties the field first and puts everything back if it is refused.
 */
export function useComposerDraft({
  draftKey,
  imageUploadEnabled,
  imageSupportMessage,
  ports,
}: {
  draftKey: string
  imageUploadEnabled: boolean
  imageSupportMessage: string | null
  ports: DraftPorts
}) {
  const store = useComposerDraftStore()
  const subscribePageExit = usePageExit()
  const readText = useCallback(() => store.getText(draftKey), [draftKey, store])
  const text = useSyncExternalStore(store.subscribe, readText, readText)
  const { uploadAttachments } = ports
  const keepsImages =
    !!uploadAttachments && !!store.getImages && !!store.setImages && !!store.keepsImages?.(draftKey)
  const readImages = useCallback(
    () => (keepsImages ? store.getImages!(draftKey) : NO_IDS),
    [draftKey, keepsImages, store],
  )
  const storedImages = useSyncExternalStore(store.subscribe, readImages, readImages)
  // Images on their way (where the draft keeps images), or waiting for the
  // send (where it does not), by draft key.
  const [pendingByKey, setPendingByKey] = useState<Record<string, DraftImageAttachment[]>>({})
  const pendingRef = useRef(pendingByKey)
  const setPending = (key: string, next: DraftImageAttachment[]) => {
    pendingRef.current = { ...pendingRef.current, [key]: next }
    setPendingByKey(pendingRef.current)
  }
  const pending = pendingByKey[draftKey] ?? NO_UPLOADS
  // Photos still being read off the phone, by draft key: they hold the send too.
  const [preparingByKey, setPreparingByKey] = useState<Record<string, number>>({})
  const preparingRef = useRef(preparingByKey)
  const prepare = (key: string, delta: number) => {
    preparingRef.current = {
      ...preparingRef.current,
      [key]: Math.max(0, (preparingRef.current[key] ?? 0) + delta),
    }
    setPreparingByKey(preparingRef.current)
  }
  const preparing = preparingByKey[draftKey] ?? 0
  // This composer's own previews of images it uploaded, so they need not be read back.
  const keptPreviews = useRef(new Map<string, { uri: string; name: string }>())
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const draftKeyRef = useRef<string | null>(draftKey)
  draftKeyRef.current = draftKey
  useEffect(
    () => () => {
      draftKeyRef.current = null
    },
    [],
  )
  useEffect(() => setError(null), [draftKey])

  // The store saves after a pause: leaving the app, or the page, writes now.
  useEffect(() => {
    const unsubscribe = subscribePageExit(() => store.flush())
    return () => {
      unsubscribe()
      store.flush()
    }
  }, [draftKey, store, subscribePageExit])

  const remoteSources = useMemo(
    () =>
      storedImages.flatMap((artifactId): ArtifactSource[] => {
        if (keptPreviews.current.has(artifactId)) return []
        const source = store.imageSource?.(draftKey, artifactId)
        return source ? [source] : []
      }),
    [draftKey, store, storedImages],
  )
  const remoteUris = useKeptUris(remoteSources)

  const images = useMemo<ComposerImage[]>(() => {
    const kept = storedImages.map((artifactId, index): ComposerImage => {
      const local = keptPreviews.current.get(artifactId)
      const remote = remoteUris[artifactId]
      return {
        id: artifactId,
        name: local?.name ?? `Image ${index + 1}`,
        ...((local?.uri ?? remote) ? { uri: local?.uri ?? remote! } : {}),
        ...(!local && remote === null ? { failed: true } : {}),
      }
    })
    const waiting = pending.map((attachment): ComposerImage => ({
      id: attachment.id,
      name: attachment.file.name,
      uri: attachment.previewUrl,
      ...(keepsImages ? { uploading: true } : {}),
    }))
    return [...kept, ...waiting]
  }, [keepsImages, pending, remoteUris, storedImages])
  const uploading = preparing > 0 || (keepsImages && pending.length > 0)

  const setText = useCallback(
    (next: string) => {
      store.setText(draftKey, next)
    },
    [draftKey, store],
  )

  /** Store a photo now and name it in the draft it was attached to, wherever the reader is by then. */
  const keep = async (key: string, attachment: DraftImageAttachment, owner: string | null) => {
    const release = store.holdImage?.(key)
    const target = store.imageTarget?.(key)
    const stillWanted = () =>
      (pendingRef.current[key] ?? NO_UPLOADS).some((each) => each.id === attachment.id)
    const settle = () =>
      setPending(
        key,
        (pendingRef.current[key] ?? NO_UPLOADS).filter((each) => each.id !== attachment.id),
      )
    const fail = (reason: string) => {
      settle()
      if (draftKeyRef.current === key)
        setError(`${attachment.file.name} was not attached. ${reason}`)
    }
    try {
      let stored: UploadedImageAttachment | undefined
      try {
        // Checked as the upload starts: the uploader stores under the session
        // open at that moment, which must be the one the photo was attached in.
        if (ports.uploadOwner && ports.uploadOwner() !== owner) {
          throw new Error('The session changed before it was stored.')
        }
        ;[stored] = await uploadAttachments!([attachment])
        if (!stored) throw new Error('The image was not stored.')
      } catch (uploadError) {
        if (stillWanted()) fail(reasonOf(uploadError, 'The upload failed.'))
        return
      }
      if (!stillWanted()) {
        settle()
        return
      }
      if (target && store.imageTargetLive && !store.imageTargetLive(target)) {
        fail('Its draft was sent or deleted meanwhile.')
        return
      }
      // Its own preview first, so naming it never sends for the bytes.
      keptPreviews.current.set(stored.id, {
        uri: attachment.previewUrl,
        name: attachment.file.name,
      })
      const current = store.getImages!(key).filter((id) => id !== stored.id)
      if (!store.setImages!(key, [...current, stored.id])) {
        keptPreviews.current.delete(stored.id)
        fail('Its draft is gone.')
        return
      }
      settle()
    } finally {
      release?.()
    }
  }

  const readPhoto = ports.readPhoto ?? photoFile
  const attachPhoto = useCallback(
    async (photo: CapturedPhoto) => {
      if (!imageUploadEnabled) {
        setError(imageSupportMessage ?? 'Image uploads are unavailable.')
        return
      }
      const key = draftKey
      const owner = ports.uploadOwner?.() ?? null
      const count =
        storedImages.length +
        (pendingRef.current[key]?.length ?? 0) +
        (preparingRef.current[key] ?? 0)
      if (count >= MAX_IMAGE_ATTACHMENTS) {
        setError(`You can attach up to ${MAX_IMAGE_ATTACHMENTS} images.`)
        return
      }
      if (!(ACCEPTED_IMAGE_TYPES as readonly string[]).includes(photo.mimeType)) {
        setError(`${photo.name} is not a PNG, JPEG, or WebP image.`)
        return
      }
      let file: File
      // Counted from here, so a send cannot go ahead of the photo being read.
      prepare(key, 1)
      try {
        file = await readPhoto(photo)
      } catch (readError) {
        setError(`${photo.name} could not be read. ${reasonOf(readError, '')}`.trim())
        return
      } finally {
        prepare(key, -1)
      }
      if (file.size <= 0 || file.size > MAX_IMAGE_BYTES) {
        setError(`${photo.name} must be smaller than 10 MB.`)
        return
      }
      const attachment: DraftImageAttachment = {
        id: globalThis.crypto.randomUUID(),
        file,
        previewUrl: photo.uri,
      }
      setError(null)
      setPending(key, [...(pendingRef.current[key] ?? NO_UPLOADS), attachment])
      // An image is the draft's first content as much as text is.
      store.claim?.(key)
      if (keepsImages) await keep(key, attachment, owner)
    },
    // `keep` reads refs and the store only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      draftKey,
      imageSupportMessage,
      imageUploadEnabled,
      keepsImages,
      ports,
      readPhoto,
      store,
      storedImages,
    ],
  )

  const removeImage = useCallback(
    (id: string) => {
      setError(null)
      if (keepsImages && store.getImages!(draftKey).includes(id)) {
        // Unnamed, the environment lets it go when held images expire.
        store.setImages!(
          draftKey,
          store.getImages!(draftKey).filter((artifactId) => artifactId !== id),
        )
        keptPreviews.current.delete(id)
        return
      }
      // Taken out on its way: the upload lands nowhere.
      setPending(
        draftKey,
        (pendingRef.current[draftKey] ?? NO_UPLOADS).filter((each) => each.id !== id),
      )
    },
    [draftKey, keepsImages, store],
  )

  const send = useCallback(async () => {
    const trimmed = text.trim()
    if ((!trimmed && images.length === 0) || sending || uploading) return
    setSending(true)
    setError(null)
    // Emptied before the round trip, as on web: the transcript shows the
    // sent message at once, and a refusal puts everything back.
    const restoreText = text
    const restoreImages = storedImages
    const restorePending = pending
    const kept: KeptImage[] = images
      .filter((image) => !image.uploading && restoreImages.includes(image.id))
      .map((image) => ({
        artifactId: image.id,
        name: image.name,
        ...(image.uri ? { previewUrl: image.uri } : {}),
      }))
    store.setText(draftKey, '')
    if (restoreImages.length > 0) store.setImages?.(draftKey, NO_IDS)
    if (!keepsImages && restorePending.length > 0) setPending(draftKey, NO_UPLOADS)
    const release = store.beginSend?.(
      draftKey,
      restoreText,
      keepsImages ? restoreImages : undefined,
    )
    try {
      const uploaded =
        !keepsImages && restorePending.length > 0
          ? await (uploadAttachments
              ? uploadAttachments(restorePending)
              : Promise.reject(new Error('This host cannot upload images')))
          : []
      await ports.send(trimmed, [...kept.map(keptAttachment), ...uploaded])
      release?.()
      for (const id of restoreImages) keptPreviews.current.delete(id)
    } catch (sendError) {
      release?.()
      // Anything typed since goes after what failed, rather than under it.
      const active = store.getText(draftKey)
      store.setText(draftKey, active ? `${restoreText}\n${active}` : restoreText)
      if (restoreImages.length > 0) {
        const now = store.getImages?.(draftKey) ?? NO_IDS
        store.setImages?.(draftKey, [
          ...restoreImages,
          ...now.filter((id) => !restoreImages.includes(id)),
        ])
      }
      if (!keepsImages && restorePending.length > 0) {
        setPending(draftKey, [...restorePending, ...(pendingRef.current[draftKey] ?? NO_UPLOADS)])
      }
      setError(reasonOf(sendError, 'Failed to send message'))
    } finally {
      setSending(false)
    }
  }, [
    draftKey,
    images,
    keepsImages,
    pending,
    ports,
    sending,
    store,
    storedImages,
    text,
    uploadAttachments,
    uploading,
  ])

  return {
    text,
    setText,
    images,
    uploading,
    sending,
    error,
    setError,
    attachPhoto,
    removeImage,
    send,
  }
}

export type ComposerDraft = ReturnType<typeof useComposerDraft>
