import { memo, useMemo, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import * as MarkdownLibrary from 'react-native-markdown-display'
import Markdown, {
  AstRenderer,
  MarkdownIt,
  parser,
  renderRules,
  type ASTNode,
  type RenderRules,
} from 'react-native-markdown-display'

import { countRender } from '../../session/render-probe'
import type { PhoneTheme } from '../../theme/tokens'
import { usePhoneTheme } from '../../theme/ThemeProvider'
import { CodeBlock } from './CodeBlock'
import { createMarkdownScanner, keyByPlace } from './markdown-blocks'
import { buildMarkdownStyles } from './markdownStyles'

/** The library's blocks end with the newline the parser leaves on them. */
const trimEnd = (content: string) => (content.endsWith('\n') ? content.slice(0, -1) : content)

const RULES: RenderRules = {
  // The library's root takes a new key on every render, which would remount
  // the whole block however little changed.
  body: (_node, children, _parent, styles) => (
    <View key="body" style={styles._VIEW_SAFE_body}>
      {children}
    </View>
  ),
  // Every run of text is selectable, so a reader can copy from a reply: the
  // library's own rule draws a plain Text.
  textgroup: (node, children, _parent, styles) => (
    <Text key={node.key} selectable style={styles.textgroup}>
      {children}
    </Text>
  ),
  fence: (node) => (
    <CodeBlock
      key={node.key}
      code={trimEnd(node.content)}
      info={(node as unknown as { sourceInfo?: string }).sourceInfo}
    />
  ),
  code_block: (node) => <CodeBlock key={node.key} code={trimEnd(node.content)} />,
}

// The library builds a markdown-it, a style sheet and a renderer for every
// mounted block of text (its defaults are made anew on each render). Rows
// mount as the reader scrolls, so the phone makes one of each, per theme for
// the renderer, and hands them in.
const MARKDOWN_IT = MarkdownIt({ typographer: true })
const IMAGE_HANDLERS = [
  'data:image/png;base64',
  'data:image/gif;base64',
  'data:image/jpeg;base64',
  'https://',
  'http://',
]
const TOO_MANY = <Text key="dotdotdot">...</Text>

type Styles = Record<string, object>

/** What the library exports and its type declarations leave out. */
const { styles: libraryStyles, removeTextStyleProps } = MarkdownLibrary as unknown as {
  styles: Styles
  removeTextStyleProps: (style: object) => object
}

/** The library's own style merge (`mergeStyle`): its defaults under the theme's. */
function mergedStyles(style: Styles): Styles {
  const merged: Styles = {}
  for (const name of Object.keys(style)) merged[name] = { ...StyleSheet.flatten(style[name]) }
  for (const name of Object.keys(libraryStyles)) {
    merged[name] = {
      ...libraryStyles[name],
      ...StyleSheet.flatten(style[name]),
    }
  }
  for (const name of Object.keys(merged)) {
    merged[`_VIEW_SAFE_${name}`] = removeTextStyleProps(merged[name]!)
  }
  return StyleSheet.create(merged) as Styles
}

const RENDERERS = new WeakMap<PhoneTheme, AstRenderer>()

/** One renderer per theme, shared by every block of text. */
function rendererFor(theme: PhoneTheme): AstRenderer {
  let renderer = RENDERERS.get(theme)
  if (!renderer) {
    const Renderer = AstRenderer as unknown as new (...args: unknown[]) => AstRenderer
    renderer = new Renderer(
      { ...renderRules, ...RULES },
      mergedStyles(buildMarkdownStyles(theme)),
      undefined,
      null,
      TOO_MANY,
      IMAGE_HANDLERS,
      'https://',
      false,
    )
    RENDERERS.set(theme, renderer)
  }
  return renderer
}

/** The library takes these props; its type declarations leave them out. */
const STABLE_PROPS = { markdownit: MARKDOWN_IT } as object

/** The library's parser with a renderer that hands the parsed tree back. */
const parseTree = parser as unknown as (
  source: string,
  renderer: (nodes: ASTNode[]) => ASTNode[],
  markdownIt: unknown,
) => ASTNode[]

/**
 * Parsed blocks, kept for the ones seen last: a row scrolled out and back is
 * drawn without parsing again. Sized for blocks, not replies: a few long
 * chats' worth.
 */
const AST_CACHE = new Map<string, ASTNode[]>()
const AST_CACHE_SIZE = 2000

function astOf(text: string, live: boolean): ASTNode[] {
  // A block still being written is a new prefix per token, never drawn again:
  // parsed, not kept, so it does not push settled blocks out of the cache.
  if (live) return parseTree(text, keyByPlace, MARKDOWN_IT)
  const hit = AST_CACHE.get(text)
  if (hit) {
    // Most recently used last, so the oldest is the one dropped.
    AST_CACHE.delete(text)
    AST_CACHE.set(text, hit)
    return hit
  }
  const ast = parseTree(text, keyByPlace, MARKDOWN_IT)
  AST_CACHE.set(text, ast)
  if (AST_CACHE.size > AST_CACHE_SIZE) {
    const oldest = AST_CACHE.keys().next().value
    if (oldest !== undefined) AST_CACHE.delete(oldest)
  }
  return ast
}

/** One top-level block of markdown, left alone once it is finished. */
const MarkdownBlock = memo(function MarkdownBlock({ text, live }: { text: string; live: boolean }) {
  countRender('MarkdownBlock')
  const theme = usePhoneTheme()
  const ast = useMemo(() => astOf(text, live), [text, live])
  return (
    <Markdown renderer={rendererFor(theme)} {...STABLE_PROPS}>
      {/* A parsed tree is drawn as it is (the library's own path for an array). */}
      {ast as unknown as string}
    </Markdown>
  )
})

/**
 * Assistant markdown with the theme's styles and highlighted code fences,
 * block by block (`markdown-blocks.ts`): a streamed token re-renders only the
 * block it lands in, and a reply settling re-renders only its last.
 */
export const TextPart = memo(function TextPart({
  text,
  live = false,
}: {
  text: string
  /** Still streaming: its last block is parsed for this render only. */
  live?: boolean
}) {
  countRender('TextPart')
  const [scanner] = useState(createMarkdownScanner)
  const { closed, tail } = useMemo(() => scanner.read(text), [scanner, text])

  if (!text) return null

  return (
    <View>
      {closed.map((block, index) => (
        <MarkdownBlock key={index} text={block} live={false} />
      ))}
      <MarkdownBlock key={closed.length} text={tail} live={live} />
    </View>
  )
})
