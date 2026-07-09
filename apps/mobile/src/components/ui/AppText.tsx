import { forwardRef } from 'react'
import {
  Text,
  type TextProps,
  type TextStyle,
  StyleSheet,
} from 'react-native'

export type AppTextVariant =
  | 'text-10-medium'
  | 'text-11-regular'
  | 'text-11-medium'
  | 'text-12-regular'
  | 'text-12-medium'
  | 'text-13-regular'
  | 'text-13-medium'
  | 'text-14-regular'
  | 'text-14-medium'
  | 'text-16-medium'
  | 'text-20-medium'
  | 'chat-assistant'
  | 'chat-prose'
  | 'chat-user'
  | 'mono'
  | 'code'
  | 'tool-output'

type AppTextProps = TextProps & {
  variant?: AppTextVariant
  className?: string
}

const uiLetterSpacing = 0.14

const variantStyles = StyleSheet.create<Record<AppTextVariant, TextStyle>>({
  'text-10-medium': {
    fontFamily: 'Geist-Medium',
    fontSize: 10,
    fontWeight: '500',
    lineHeight: 16,
    letterSpacing: uiLetterSpacing,
  },
  'text-11-regular': {
    fontFamily: 'Geist-Regular',
    fontSize: 11,
    fontWeight: '400',
    lineHeight: 17.6,
    letterSpacing: uiLetterSpacing,
  },
  'text-11-medium': {
    fontFamily: 'Geist-Medium',
    fontSize: 11,
    fontWeight: '500',
    lineHeight: 17.6,
    letterSpacing: uiLetterSpacing,
  },
  'text-12-regular': {
    fontFamily: 'Geist-Regular',
    fontSize: 12,
    fontWeight: '400',
    lineHeight: 15.6,
    letterSpacing: uiLetterSpacing,
  },
  'text-12-medium': {
    fontFamily: 'Geist-Medium',
    fontSize: 12,
    fontWeight: '500',
    lineHeight: 19.2,
    letterSpacing: uiLetterSpacing,
  },
  'text-13-regular': {
    fontFamily: 'Geist-Regular',
    fontSize: 13,
    fontWeight: '400',
    lineHeight: 20.8,
    letterSpacing: uiLetterSpacing,
  },
  'text-13-medium': {
    fontFamily: 'Geist-Medium',
    fontSize: 13,
    fontWeight: '500',
    lineHeight: 20.8,
    letterSpacing: uiLetterSpacing,
  },
  'text-14-regular': {
    fontFamily: 'Geist-Regular',
    fontSize: 14,
    fontWeight: '400',
    lineHeight: 22.4,
    letterSpacing: uiLetterSpacing,
  },
  'text-14-medium': {
    fontFamily: 'Geist-Medium',
    fontSize: 14,
    fontWeight: '500',
    lineHeight: 22.4,
    letterSpacing: uiLetterSpacing,
  },
  'text-16-medium': {
    fontFamily: 'Geist-Medium',
    fontSize: 16,
    fontWeight: '500',
    lineHeight: 28,
    letterSpacing: uiLetterSpacing,
  },
  'text-20-medium': {
    fontFamily: 'Geist-Medium',
    fontSize: 20,
    fontWeight: '500',
    lineHeight: 38,
    letterSpacing: -0.4,
  },
  'chat-assistant': {
    fontFamily: 'Geist-Regular',
    fontSize: 14,
    fontWeight: '400',
    lineHeight: 24.5,
  },
  'chat-prose': {
    fontFamily: 'Geist-Regular',
    fontSize: 14,
    fontWeight: '400',
    lineHeight: 24.5,
  },
  'chat-user': {
    fontFamily: 'Geist-Regular',
    fontSize: 14,
    fontWeight: '400',
    lineHeight: 22.75,
  },
  mono: {
    fontFamily: 'JetBrainsMono-Regular',
    fontSize: 13,
    fontWeight: '400',
    lineHeight: 20.8,
  },
  code: {
    fontFamily: 'JetBrainsMono-Regular',
    fontSize: 13,
    fontWeight: '400',
    lineHeight: 20.8,
  },
  'tool-output': {
    fontFamily: 'JetBrainsMono-Regular',
    fontSize: 13,
    fontWeight: '400',
    lineHeight: 20.8,
  },
})

export const AppText = forwardRef<Text, AppTextProps>(function AppText(
  { variant = 'text-13-regular', className, style, ...props },
  ref,
) {
  return (
    <Text
      ref={ref}
      className={['text-foreground', className].filter(Boolean).join(' ')}
      style={[variantStyles[variant], style]}
      {...props}
    />
  )
})

export { variantStyles as appTextVariantStyles }
