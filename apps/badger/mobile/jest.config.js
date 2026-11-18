const path = require('path');

// react-native is an alias of react-native-tvos here, so Bun's isolated layout links it only under this
// app's node_modules: the preset (and its asset transformer, run in Jest workers) resolve `react-native`
// from its own .bun directory and would not find it. NODE_PATH adds this app's node_modules to Node's
// fallback lookup, here and in the workers, which inherit the environment.
process.env.NODE_PATH = [path.join(__dirname, 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
require('module').Module._initPaths();
const rnPreset = require('@react-native/jest-preset');

module.exports = {
  ...rnPreset,
  // Jest owns only the React Native render smoke test(s) in __tests__/. The logic suites in
  // tests/ are vitest files (`test:logic`) that jest cannot parse.
  testMatch: ['<rootDir>/__tests__/**/*.test.{ts,tsx}'],
  // Avoid loading RN's bundled setup file directly because Bun's install layout
  // makes Jest parse it untransformed.
  setupFiles: ['<rootDir>/jest.setup.js'],
  // Preserve RN transforms when packages are nested under Bun's node_modules/.bun/... layout.
  transformIgnorePatterns: [
    'node_modules/(?!(?:\\.bun\\/[^/]+\\/node_modules\\/)?(?:jest-)?react-native|@react-native(?:-community)?/)',
  ],
};
