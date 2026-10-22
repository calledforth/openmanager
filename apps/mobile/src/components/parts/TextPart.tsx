import { memo, useMemo } from 'react'
import Markdown, { type RenderRules } from 'react-native-markdown-display'

import { countRender } from '../../session/render-probe'
import { usePhoneTheme } from '../../theme/ThemeProvider'
import { CodeBlock } from './CodeBlock'
import { buildMarkdownStyles } from './markdownStyles'

/** The library's blocks end with the newline the parser leaves on them. */
const trimEnd = (content: string) => (content.endsWith('\n') ? content.slice(0, -1) : content)

const RULES: RenderRules = {
  fence: (node) => (
    <CodeBlock
      key={node.key}
      code={trimEnd(node.content)}
      info={(node as unknown as { sourceInfo?: string }).sourceInfo}
    />
  ),
  code_block: (node) => <CodeBlock key={node.key} code={trimEnd(node.content)} />,
}

/**
 * Assistant markdown with the theme's styles and highlighted code fences.
 * One part's text: a streamed token re-renders only the part it lands in.
 */
export const TextPart = memo(function TextPart({ text }: { text: string }) {
  countRender('TextPart')
  const theme = usePhoneTheme()
  const styles = useMemo(() => buildMarkdownStyles(theme), [theme])

  if (!text) return null

  return (
    <Markdown style={styles} rules={RULES}>
      {text}
    </Markdown>
  )
})
