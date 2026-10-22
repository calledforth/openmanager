import type { TextStyle, ViewStyle } from 'react-native'

import type { PhoneTheme } from '../../theme/tokens'

// Token-driven style map for react-native-markdown-display (`mergeStyle`
// defaults to true, so these merge onto the library defaults), after the
// session mockup (docs/ui-prototypes/mobile/01-home-and-session.html):
//   - prose 15 / 1.55 in the scheme's ink
//   - inline code = mono on a soft fill, no outline
//   - fenced code = its own component (CodeBlock), highlighted, on a fill
//   - strong = emphasis by colour, not weight
// The library inherits text-style props (color/fontStyle/fontFamily/…) from a
// node's ancestors, so setting them on block containers cascades to text.

const MONO = 'JetBrainsMono-Regular'
const SANS = 'Geist-Regular'
const SANS_MEDIUM = 'Geist-Medium'

export function buildMarkdownStyles(theme: PhoneTheme): Record<string, TextStyle | ViewStyle> {
  const text = theme.tokens['basis-text']
  return {
    body: { color: text, fontFamily: SANS, fontSize: 15, lineHeight: 23.25 },
    text: { color: text },
    paragraph: { marginTop: 0, marginBottom: 10 },

    // Colour-based emphasis, not weight.
    strong: { fontWeight: '400', fontFamily: SANS_MEDIUM, color: theme.fg },
    em: { fontStyle: 'italic', color: text },
    s: { color: theme.muted },

    link: { color: theme.fg, textDecorationLine: 'underline' },

    code_inline: {
      fontFamily: MONO,
      fontSize: 13,
      color: theme.fg,
      backgroundColor: theme.hover,
      borderWidth: 0,
      borderRadius: 4,
      paddingHorizontal: 4,
      // The fill hugs the glyphs rather than the prose's taller line.
      lineHeight: 18,
    },

    // Quotes lean on a bar of the faint ink, the one rule prose keeps.
    blockquote: {
      backgroundColor: 'transparent',
      borderColor: theme.faint,
      borderLeftColor: theme.faint,
      borderLeftWidth: 3,
      marginLeft: 0,
      marginVertical: 6,
      paddingLeft: 12,
      paddingHorizontal: 0,
      color: theme.muted,
      fontStyle: 'italic',
    },

    bullet_list: { marginVertical: 4 },
    ordered_list: { marginVertical: 4 },
    list_item: { marginVertical: 2 },
    bullet_list_icon: { color: theme.faint, marginLeft: 2, marginRight: 8 },
    ordered_list_icon: { color: theme.faint, marginLeft: 2, marginRight: 8 },

    // Headings: colour emphasis, medium weight, relative sizes.
    heading1: {
      fontSize: 19,
      lineHeight: 26,
      fontFamily: SANS_MEDIUM,
      color: theme.fg,
      marginTop: 14,
      marginBottom: 6,
    },
    heading2: {
      fontSize: 17,
      lineHeight: 24,
      fontFamily: SANS_MEDIUM,
      color: theme.fg,
      marginTop: 12,
      marginBottom: 6,
    },
    heading3: {
      fontSize: 15.5,
      lineHeight: 22,
      fontFamily: SANS_MEDIUM,
      color: theme.fg,
      marginTop: 10,
      marginBottom: 4,
    },
    heading4: { fontSize: 15, fontFamily: SANS_MEDIUM, color: theme.fg, marginTop: 10 },
    heading5: { fontSize: 14, fontFamily: SANS_MEDIUM, color: theme.fg, marginTop: 8 },
    heading6: { fontSize: 14, fontFamily: SANS_MEDIUM, color: theme.muted, marginTop: 8 },

    hr: { backgroundColor: theme.rule, height: 1, marginVertical: 12 },

    // A table is a list that needs its rules.
    table: {
      borderWidth: 0,
      borderRadius: 8,
      overflow: 'hidden',
      marginVertical: 6,
      backgroundColor: theme.hover,
    },
    th: { flex: 1, padding: 8 },
    tr: { borderBottomWidth: 1, borderColor: theme.rule, flexDirection: 'row' },
    td: { flex: 1, padding: 8, fontSize: 13 },
  }
}
