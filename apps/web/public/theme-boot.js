// Applies the saved theme and font before the app's stylesheet paints, so a
// reload does not flash the default theme. It is a file rather than an inline
// script because the hosted CSP allows no inline scripts (see public/_headers).
try {
  var theme = localStorage.getItem('openmanager-theme')
  if (theme === 'light' || theme === 'black') document.documentElement.dataset.theme = theme
  var font = localStorage.getItem('openmanager-font')
  if (font) document.documentElement.dataset.uiFont = font
} catch (error) {
  /* ignore */
}
