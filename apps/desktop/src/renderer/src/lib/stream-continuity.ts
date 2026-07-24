export function shouldUseRemoteStreaming(
  role: string,
  isFinal: boolean | undefined,
  isDriven: boolean,
): boolean {
  return role === 'assistant' && isFinal !== true && !isDriven
}
