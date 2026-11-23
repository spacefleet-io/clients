const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');
const path = require('path');
// The Google-free Android build (SF_FOSS=1, PLAT-MOBILE-06): the pairing screen's QR scanner is left out.
const { withFossStubs } = require('../../../packages/mobile-shell/foss.cjs');

const repoRoot = path.resolve(__dirname, '../../..');
const bunModules = path.resolve(repoRoot, 'node_modules/.bun');
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Workspace packages the app imports, by import name.
const workspacePackages = {
  '@space/shared': 'packages/shared',
  '@space/sdk': 'packages/sdk',
  '@space/library-db-definition': 'packages/library-db-definition',
  '@space/mobile-shell': 'packages/mobile-shell',
  '@space/mobile-media-proxy': 'packages/mobile-media-proxy',
  '@space/mobile-audio-playback': 'packages/mobile-audio-playback',
  '@space/mobile-media-volume': 'packages/mobile-media-volume',
  '@space/error-report': 'packages/error-report',
  '@space/parrot-core': 'packages/parrot-core',
  '@space/parrot-library-db-definition': 'packages/parrot-library-db-definition',
  '@space/playback-abr': 'packages/playback-abr',
  '@space/pairing-crypto': 'packages/pairing-crypto',
  '@space/legal': 'packages/legal',
  '@space/metadata-client': 'packages/metadata-client',
  '@space/privacy-pass': 'packages/privacy-pass',
  '@space/stream-slots': 'packages/stream-slots',
  '@space/profile-avatars': 'packages/profile-avatars',
};
const workspaceRoots = Object.values(workspacePackages).map((dir) => path.resolve(repoRoot, dir));

// Bun links peer dependencies into each workspace package's own node_modules, sometimes at other versions than the
// app's (a second React or React Native in one bundle crashes). Blocking them makes Metro resolve from the app.
const workspaceNodeModulesBlockList = workspaceRoots.map(
  (dir) => new RegExp(`${escapeRegex(path.join(dir, 'node_modules'))}(/.*)?$`)
);

const config = {
  watchFolders: [repoRoot, ...workspaceRoots, bunModules],
  resolver: {
    blockList: [
      // The gradle plugin holds Kotlin build output whose vanishing dirs crash Metro's watcher.
      new RegExp(`${escapeRegex(bunModules)}/@react-native\\+gradle-plugin@.*`),
      ...workspaceNodeModulesBlockList,
      // Native build output under any android/ dir (never JS; CMake temp dirs crash the watcher).
      /[/\\]android[/\\](?:.*[/\\])?(?:\.cxx|build|\.gradle)(?:[/\\].*)?$/,
    ],
    unstable_enableSymlinks: true,
    extraNodeModules: Object.fromEntries(
      Object.entries(workspacePackages).map(([name, dir]) => [name, path.resolve(repoRoot, dir)])
    ),
    resolveRequest: withFossStubs((context, moduleName, platform) => {
      // Shared packages import Node's crypto; on the phone it is react-native-quick-crypto.
      if (moduleName === 'node:crypto' || moduleName === 'crypto') {
        return context.resolveRequest(context, 'react-native-quick-crypto', platform);
      }
      // Every `react-native` import is the app's own copy: the repo also holds the react-native-tvos fork (Badger),
      // and two React Native JS copies in one bundle crash at launch.
      if (moduleName === 'react-native' || moduleName.startsWith('react-native/')) {
        return context.resolveRequest({ ...context, originModulePath: path.join(__dirname, 'index.js') }, moduleName, platform);
      }
      return context.resolveRequest(context, moduleName, platform);
    }),
    nodeModulesPaths: [path.resolve(__dirname, 'node_modules'), path.resolve(repoRoot, 'node_modules')],
  },
  // The inlined PARROT_API_BASE_URL, PARROT_METADATA_TICKETS and EXPO_PUBLIC_METADATA_URL (babel-plugin-api-base-url.js,
  // which also reads SF_LOCAL_METADATA) change the transformed code.
  cacheVersion: `api-base-url:${(process.env.PARROT_API_BASE_URL ?? '').trim()}:tickets:${(process.env.PARROT_METADATA_TICKETS ?? '').trim()}:metadata:${(process.env.EXPO_PUBLIC_METADATA_URL ?? '').trim()}:local:${(process.env.SF_LOCAL_METADATA ?? '').trim()}`,
  serializer: {
    getModulesRunBeforeMainModule: () => [
      require.resolve('react-native/setup-env', { paths: [__dirname] }),
    ],
  },
  server: {
    // Debug builds ask for lazy bundles, which fetch each `import()` as its own bundle by a path relative to this app
    // (`/../../../node_modules/.bun/...`); the server collapses the `..` and cannot find the module, so the opt-in
    // error reports (`await import("@sentry/react-native")`) never start in a debug build. Bundling eagerly keeps
    // those imports inside the main bundle, as release builds already do.
    rewriteRequestUrl: (url) => url.replace('lazy=true', 'lazy=false'),
  },
};

// Release builds whose error reports (REL-LOG-06) read as source lines: see @space/error-report/metro.
module.exports = require('@space/error-report/metro').withErrorReportSourcemaps(
  mergeConfig(getDefaultConfig(__dirname), config),
  __dirname
);
