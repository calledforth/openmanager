import type { TextStyle, ViewStyle } from 'react-native'

import type { BasisTokens } from '../../theme/tokens'

// Token-driven style map for react-native-markdown-display (`mergeStyle`
// defaults to true, so these merge onto the library defaults). Mirrors the
// desktop `TextPart` markdown rules under §4.2:
//   - inline code = JetBrains Mono + primary color, transparent background
//   - code blocks = surface bg + borderMuted + mono 13
//   - strong = weight 400 + textStrong color (emphasis by color, NOT bold)
//   - blockquote = 3px left border primary, italic, textMuted
// The library inherits text-style props (color/fontStyle/fontFamily/…) from a
// node's ancestors, so setting them on block containers cascades to text.

const MONO = 'JetBrainsMono-Regular'
const SANS = 'Geist-Regular'

export function buildMarkdownStyles(t: BasisTokens): Record<string, TextStyle | ViewStyle> {
  return {
    // chat-prose base (§4.2): 14 / 24.5, cascades to all text nodes.
    body: { color: t.text, fontFamily: SANS, fontSize: 14, lineHeight: 24.5 },
    text: { color: t.text },
    paragraph: { marginTop: 0, marginBottom: 8 },

    // Color-based emphasis, not weight.
    strong: { fontWeight: '400', fontFamily: SANS, color: t.textStrong },
    em: { fontStyle: 'italic', color: t.text },
    s: { color: t.textMuted },

    link: { color: t.textStrong, textDecorationLine: 'underline' },

    // Inline code: mono + primary color on a transparent chip.
    code_inline: {
      fontFamily: MONO,
      fontSize: 13,
      color: t.textStrong,
      backgroundColor: 'transparent',
      borderWidth: 0,
      padding: 0,
      borderRadius: 0,
    },

    // Fenced / indented blocks: surface bg, borderMuted, mono 13.
    code_block: {
      fontFamily: MONO,
      fontSize: 13,
      lineHeight: 20.8,
      color: t.text,
      backgroundColor: t.surface,
      borderWidth: 1,
      borderColor: t.borderMuted,
      borderRadius: 6,
      padding: 12,
      marginVertical: 6,
    },
    fence: {
      fontFamily: MONO,
      fontSize: 13,
      lineHeight: 20.8,
      color: t.text,
      backgroundColor: t.surface,
      borderWidth: 1,
      borderColor: t.borderMuted,
      borderRadius: 6,
      padding: 12,
      marginVertical: 6,
    },

    // 3px left border primary, italic, textMuted.
    blockquote: {
      backgroundColor: 'transparent',
      borderColor: t.textStrong,
      borderLeftColor: t.textStrong,
      borderLeftWidth: 3,
      marginLeft: 0,
      marginVertical: 6,
      paddingLeft: 12,
      paddingHorizontal: 0,
      color: t.textMuted,
      fontStyle: 'italic',
    },

    bullet_list: { marginVertical: 4 },
    ordered_list: { marginVertical: 4 },
    list_item: { marginVertical: 2 },

    // Headings: color emphasis, weight 400, relative sizes.
    heading1: {
      fontSize: 18,
      fontWeight: '400',
      color: t.textStrong,
      marginTop: 14,
      marginBottom: 4,
    },
    heading2: {
      fontSize: 16,
      fontWeight: '400',
      color: t.textStrong,
      marginTop: 12,
      marginBottom: 4,
    },
    heading3: {
      fontSize: 15,
      fontWeight: '400',
      color: t.textStrong,
      marginTop: 10,
      marginBottom: 4,
    },
    heading4: {
      fontSize: 14,
      fontWeight: '400',
      color: t.textStrong,
      marginTop: 10,
      marginBottom: 4,
    },
    heading5: {
      fontSize: 13,
      fontWeight: '400',
      color: t.textStrong,
      marginTop: 8,
      marginBottom: 4,
    },
    heading6: {
      fontSize: 13,
      fontWeight: '400',
      color: t.textMuted,
      marginTop: 8,
      marginBottom: 4,
    },

    hr: { backgroundColor: t.border, height: 1, marginVertical: 12 },

    table: { borderWidth: 1, borderColor: t.border, borderRadius: 6, marginVertical: 6 },
    th: { flex: 1, padding: 8, borderColor: t.border },
    tr: { borderBottomWidth: 1, borderColor: t.border, flexDirection: 'row' },
    td: { flex: 1, padding: 8, borderColor: t.border, fontSize: 12 },
  }
}
