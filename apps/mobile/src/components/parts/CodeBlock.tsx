import { memo, useMemo } from 'react'
import { ScrollView, Text, View } from 'react-native'

import type { PhoneTheme } from '../../theme/tokens'
import { usePhoneTheme } from '../../theme/ThemeProvider'
import { AppText } from '../ui/AppText'
import { highlightCode, languageLabel, type CodeTokenKind } from './highlight'

const MONO = 'JetBrainsMono-Regular'

/** Each kind of token in one of the theme's own colours. */
function tokenColor(kind: CodeTokenKind, theme: PhoneTheme): string {
  switch (kind) {
    case 'keyword':
      return theme.status.working
    case 'string':
      return theme.status.done
    case 'number':
      return theme.status.background
    case 'comment':
      return theme.faint
    default:
      return theme.fg
  }
}

/**
 * A fenced block of code on a fill: highlighted line by line, scrolled
 * sideways rather than wrapped, its language named in the corner.
 */
export const CodeBlock = memo(function CodeBlock({ code, info }: { code: string; info?: string }) {
  const theme = usePhoneTheme()
  const lines = useMemo(() => highlightCode(code, info), [code, info])
  const language = languageLabel(info)
  return (
    <View
      style={{
        backgroundColor: theme.hover,
        borderRadius: 10,
        marginVertical: 6,
        overflow: 'hidden',
      }}
    >
      {language ? (
        <AppText
          variant="text-11-regular"
          style={{ color: theme.faint, paddingHorizontal: 12, paddingTop: 8 }}
        >
          {language}
        </AppText>
      ) : null}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{
          paddingHorizontal: 12,
          paddingTop: language ? 4 : 10,
          paddingBottom: 10,
        }}
      >
        <Text
          selectable
          style={{ fontFamily: MONO, fontSize: 12.5, lineHeight: 19, color: theme.fg }}
        >
          {lines.map((tokens, row) => (
            <Text key={row}>
              {tokens.map((token, index) =>
                token.kind === 'plain' ? (
                  token.text
                ) : (
                  <Text
                    key={index}
                    style={{
                      color: tokenColor(token.kind, theme),
                      ...(token.kind === 'comment' ? { fontStyle: 'italic' as const } : null),
                    }}
                  >
                    {token.text}
                  </Text>
                ),
              )}
              {row < lines.length - 1 ? '\n' : null}
            </Text>
          ))}
        </Text>
      </ScrollView>
    </View>
  )
})
