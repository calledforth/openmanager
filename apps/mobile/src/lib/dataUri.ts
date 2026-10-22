/** A Blob as a data URI the native image view can show. */
export function readAsDataUri(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () =>
      typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('Unreadable'))
    reader.onerror = () => reject(reader.error ?? new Error('Unreadable'))
    reader.readAsDataURL(blob)
  })
}
