// The app's entry. The runtime fills go first, before expo-router loads a
// single route, so shared code never sees React Native's partial `URL` or a
// missing `AbortSignal.timeout` / `crypto.randomUUID`.
import './src/environment/polyfills'
import 'expo-router/entry'
