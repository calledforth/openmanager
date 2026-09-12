/**
 * The web shell shares app-core's theme context so shared components (the
 * sidebar's provider icons, for instance) read the same provider the settings
 * page writes to.
 */
export {
  ThemeProvider,
  useTheme,
  type ThemeMode,
} from '@openmanager/app-core/providers/theme-provider'
