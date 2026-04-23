import type { Preview } from '@storybook/react-vite'
import React, { useEffect } from 'react'
import '../src/renderer/src/styles/globals.css'
import './custom.css'

const fontThemeDecorator = (Story, context) => {
  const fontChoice = context.globals.fontFamily || 'geist'

  useEffect(() => {
    let fontVar = "'Geist Sans', ui-sans-serif, system-ui, sans-serif"
    if (fontChoice === 'inter') {
      fontVar = "'Inter Variable', 'Inter', ui-sans-serif, system-ui, sans-serif"
    } else if (fontChoice === 'public-sans') {
      fontVar = "'Public Sans Variable', 'Public Sans', ui-sans-serif, system-ui, sans-serif"
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
      defaultValue: 'geist',
      toolbar: {
        icon: 'paintbrush',
        items: [
          { value: 'geist', title: 'Geist Sans' },
          { value: 'inter', title: 'Inter' },
          { value: 'public-sans', title: 'Public Sans' },
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
