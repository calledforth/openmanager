import { useMemo } from 'react'
import Markdown from 'react-native-markdown-display'

import { useTokens } from '../../theme/useTokens'
import { buildMarkdownStyles } from './markdownStyles'

// Mirror of the desktop `TextPart`: renders assistant markdown with the §4.2
// token-mapped styles. No syntax highlighting in the MVP.

export function TextPart({ text }: { text: string }) {
  const tokens = useTokens()
  const styles = useMemo(() => buildMarkdownStyles(tokens), [tokens])

  if (!text) return null

  return <Markdown style={styles}>{text}</Markdown>
}
