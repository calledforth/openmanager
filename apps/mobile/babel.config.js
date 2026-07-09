module.exports = function (api) {
  api.cache(true)

  return {
    presets: [
      ['babel-preset-expo', { jsxImportSource: 'nativewind' }],
      'nativewind/babel',
    ],
    // Required for react-native-reanimated (v4 uses the worklets plugin, which
    // must be listed last). Powers the pulsing status dot.
    plugins: ['react-native-worklets/plugin'],
  }
}
