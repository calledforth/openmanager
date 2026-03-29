import type { Preview } from '@storybook/react-vite'
import React, { useEffect } from 'react'
import '../src/renderer/src/styles/globals.css'
import './custom.css'

const fontThemeDecorator = (Story, context) => {
  const fontChoice = context.globals.fontFamily || 'public-sans'

  useEffect(() => {
    let fontVar = "'Public Sans Variable', 'Public Sans', system-ui, sans-serif"
    if (fontChoice === 'inter') {
      fontVar = "'Inter Variable', 'Inter', system-ui, sans-serif"
    } else if (fontChoice === 'geist') {
      fontVar = "'Geist Sans', system-ui, sans-serif"
    }

    document.documentElement.style.setProperty('--font-sans', fontVar)
  }, [fontChoice])

  return <Story />
}

const preview: Preview = {
  globalTypes: {
    fontFamily: {
      name: 'Font',
      description: 'Switch between UI fonts',
      defaultValue: 'public-sans',
      toolbar: {
        icon: 'paintbrush',
        items: [
          { value: 'public-sans', title: 'Public Sans' },
          { value: 'inter', title: 'Inter' },
          { value: 'geist', title: 'Geist Sans' },
        ],
      },
    },
  },
  decorators: [fontThemeDecorator],
  parameters: {
    actions: { argTypesRegex: '^on.*' },
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
    layout: 'fullscreen',
  },
}

export default preview
