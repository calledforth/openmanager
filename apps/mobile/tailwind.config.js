/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: ['./src/**/*.{ts,tsx}'],
  presets: [require('nativewind/preset')],
  theme: {
    extend: {
      colors: {
        canvasBg: 'var(--canvas-bg)',
        surface: 'var(--surface)',
        surfaceElevated: 'var(--surface-elevated)',
        surfaceHover: 'var(--surface-hover)',
        tabActiveBg: 'var(--tab-active-bg)',
        border: 'var(--border)',
        borderMuted: 'var(--border-muted)',
        text: 'var(--text)',
        textStrong: 'var(--text-strong)',
        textMuted: 'var(--text-muted)',
        textFaint: 'var(--text-faint)',
        actionBg: 'var(--action-bg)',
        actionFg: 'var(--action-fg)',
        actionHover: 'var(--action-hover)',
        destructive: 'var(--destructive)',
        destructiveFg: 'var(--destructive-fg)',
        background: 'var(--background)',
        foreground: 'var(--foreground)',
        card: 'var(--card)',
        popover: 'var(--popover)',
        primary: 'var(--primary)',
        mutedForeground: 'var(--muted-foreground)',
        accent: 'var(--accent)',
        input: 'var(--input)',
      },
      borderRadius: {
        DEFAULT: '6px',
      },
      fontFamily: {
        sans: ['Geist-Regular', 'Geist-Medium', 'Geist-SemiBold'],
        mono: ['JetBrainsMono-Regular', 'JetBrainsMono-Medium'],
      },
    },
  },
  plugins: [],
}
