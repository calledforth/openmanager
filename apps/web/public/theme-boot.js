// Applies the saved theme and font before the app's stylesheet paints, so a
// reload does not flash the default theme. It is a file rather than an inline
// script because the hosted CSP allows no inline scripts (see public/_headers).
// The appearance carries the scheme each mode resolves to (ThemeProvider
// writes it), so this only has to pick light or dark. Each read stands alone,
// so one unreadable value cannot stop the others.
try {
  var font = localStorage.getItem('openmanager-font')
  if (font) document.documentElement.dataset.uiFont = font
} catch (error) {
  /* ignore */
}

// Schemes since gone, for a value saved before then (until ThemeProvider next
// saves): each paints the scheme that replaced it, as
// lib/theme-families.ts maps them. Black moved from Default to Lovable, so a
// Default appearance that picked it now paints Lovable, either side.
var replaced = { 'neutral-light-soft': 'neutral-light', 'lovable-light-inverse': 'lovable-light' }

var theme = null
try {
  theme = localStorage.getItem('openmanager-theme')
  if (theme === 'black') theme = 'lovable'
} catch (error) {
  /* ignore */
}
try {
  var appearance = JSON.parse(localStorage.getItem('openmanager-appearance') || 'null')
  if (appearance && typeof appearance === 'object') {
    var scheme =
      appearance.mode === 'system'
        ? window.matchMedia('(prefers-color-scheme: light)').matches
          ? 'light'
          : 'dark'
        : appearance.mode
    var resolved = appearance[scheme]
    if (appearance.family === 'default' && appearance.dark === 'black') {
      resolved = scheme === 'dark' ? 'lovable' : 'lovable-light'
    }
    if (typeof resolved === 'string') theme = resolved
  }
} catch (error) {
  /* unreadable: keep the single saved scheme */
}
if (theme && Object.prototype.hasOwnProperty.call(replaced, theme)) theme = replaced[theme]
if (theme && theme !== 'dark' && /^[a-z-]+$/.test(theme)) {
  document.documentElement.dataset.theme = theme
}
