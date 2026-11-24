const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');
const path = require('path');
// The Google-free Android build (SF_FOSS=1, PLAT-MOBILE-06): Google Cast and Firebase imports resolve to stand-ins.
// Outside it (Play, iOS), @space/mobile-self-update resolves to its stand-in (REL-UPD-06).
const { withFossStubs, withSelfUpdate } = require('../../../packages/mobile-shell/foss.cjs');

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
const repoRoot = path.resolve(__dirname, '../../..');
const bunModules = path.resolve(repoRoot, 'node_modules/.bun');
const sharedRoot = path.resolve(repoRoot, 'packages/shared');
const libraryDbRoot = path.resolve(repoRoot, 'packages/library-db');
const libraryDbDefinitionRoot = path.resolve(repoRoot, 'packages/library-db-definition');
const mobileShellRoot = path.resolve(repoRoot, 'packages/mobile-shell');
const mobileMpvPlaybackRoot = path.resolve(repoRoot, 'packages/mobile-mpv-playback');
const mobileMediaProxyRoot = path.resolve(repoRoot, 'packages/mobile-media-proxy');
const mobileMediaVolumeRoot = path.resolve(repoRoot, 'packages/mobile-media-volume');
const mobileSelfUpdateRoot = path.resolve(repoRoot, 'packages/mobile-self-update');
const mobileMediaSessionRoot = path.resolve(repoRoot, 'packages/mobile-media-session');
const mediaSessionRoot = path.resolve(repoRoot, 'packages/media-session');
const playbackAbrRoot = path.resolve(repoRoot, 'packages/playback-abr');
const pairingCryptoRoot = path.resolve(repoRoot, 'packages/pairing-crypto');
const mediaCryptoRoot = path.resolve(repoRoot, 'packages/media-crypto');
const errorReportRoot = path.resolve(repoRoot, 'packages/error-report');
const metadataClientRoot = path.resolve(repoRoot, 'packages/metadata-client');
const privacyPassRoot = path.resolve(repoRoot, 'packages/privacy-pass');
const sdkRoot = path.resolve(repoRoot, 'packages/sdk');
const legalRoot = path.resolve(repoRoot, 'packages/legal');
const streamSlotsRoot = path.resolve(repoRoot, 'packages/stream-slots');
const profileAvatarsRoot = path.resolve(repoRoot, 'packages/profile-avatars');
const ingestCoreRoot = path.resolve(repoRoot, 'packages/ingest-core');
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Workspace packages whose node_modules should be invisible to Metro.
// Bun installs peer dep symlinks into workspace packages' node_modules, which
// can point to different versions than the app's copies (e.g. react@19.2.4 vs
// react@19.2.3), causing dual-instance crashes. Blocking these directories
// forces Metro to resolve everything from the app's node_modules instead.
const workspaceNodeModulesBlockList = [sharedRoot, libraryDbRoot, libraryDbDefinitionRoot, mobileShellRoot, mobileMpvPlaybackRoot, mobileMediaProxyRoot, mobileMediaVolumeRoot, mobileSelfUpdateRoot, mobileMediaSessionRoot, mediaSessionRoot, playbackAbrRoot, errorReportRoot, metadataClientRoot, privacyPassRoot, sdkRoot, streamSlotsRoot, profileAvatarsRoot, ingestCoreRoot]
  .map((dir) => new RegExp(`${escapeRegex(path.join(dir, 'node_modules'))}(/.*)?$`));

const config = {
  watchFolders: [repoRoot, sharedRoot, libraryDbRoot, libraryDbDefinitionRoot, mobileShellRoot, mobileMpvPlaybackRoot, mobileMediaProxyRoot, mobileMediaVolumeRoot, mobileMediaSessionRoot, mediaSessionRoot, playbackAbrRoot, pairingCryptoRoot, mediaCryptoRoot, errorReportRoot, metadataClientRoot, privacyPassRoot, sdkRoot, legalRoot, streamSlotsRoot, profileAvatarsRoot, ingestCoreRoot, bunModules],
  resolver: {
    blockList: [
      // Gradle plugin contains Kotlin build artifacts with missing dirs that crash Metro's watcher
      new RegExp(`${escapeRegex(bunModules)}/@react-native\\+gradle-plugin@.*`),
      ...workspaceNodeModulesBlockList,
      // Native build output (gradle/CMake) anywhere under an android/ dir. CMake
      // creates and deletes temp dirs there during builds, and Metro's watcher
      // crashes (ENOENT) when one vanishes before it attaches. Never JS.
      /[/\\]android[/\\](?:.*[/\\])?(?:\.cxx|build|\.gradle)(?:[/\\].*)?$/,
    ],
    unstable_enableSymlinks: true,
    extraNodeModules: {
      '@space/shared': sharedRoot,
      '@space/library-db': libraryDbRoot,
      '@space/library-db-definition': libraryDbDefinitionRoot,
      '@space/mobile-shell': mobileShellRoot,
      '@space/mobile-mpv-playback': mobileMpvPlaybackRoot,
      '@space/mobile-media-proxy': mobileMediaProxyRoot,
      '@space/mobile-media-volume': mobileMediaVolumeRoot,
      '@space/mobile-self-update': mobileSelfUpdateRoot,
      '@space/mobile-media-session': mobileMediaSessionRoot,
      '@space/media-session': mediaSessionRoot,
      '@space/playback-abr': playbackAbrRoot,
      '@space/pairing-crypto': pairingCryptoRoot,
      // SFV1's format constants and padding rule (a fetched subtitle is sealed on the phone, PLAY-SUBGET-03).
      '@space/media-crypto': mediaCryptoRoot,
      // Its node_modules is blocked above, so its @sentry/react-native import resolves to the app's single copy.
      '@space/error-report': errorReportRoot,
      '@space/metadata-client': metadataClientRoot,
      '@space/privacy-pass': privacyPassRoot,
      // @space/shared's API client is built on the generated SDK.
      '@space/sdk': sdkRoot,
      // Settings > About's credits (MobileCreditsPanel).
      '@space/legal': legalRoot,
      // The account's stream limit (ACCT-STREAM): the player's "Play here instead?" gate.
      '@space/stream-slots': streamSlotsRoot,
      // The profile avatar pack's 256 px WebP pictures (ACCT-PROF-05); `webp` is in Metro's default assetExts.
      '@space/profile-avatars': profileAvatarsRoot,
      // An added subtitle file's language (franc, PLAY-SUBGET-23); only `@space/ingest-core/subtitleLanguageDetection`
      // is imported, none of the ingest's Node code.
      '@space/ingest-core': ingestCoreRoot,
    },
    // Shared packages also run on desktop/server and import Node's crypto
    // (e.g. randomUUID in library-db-definition migrations). On device that
    // API comes from react-native-quick-crypto, a drop-in replacement.
    resolveRequest: withSelfUpdate(withFossStubs((context, moduleName, platform) => {
      if (moduleName === 'node:crypto' || moduleName === 'crypto') {
        return context.resolveRequest(context, 'react-native-quick-crypto', platform);
      }
      // Every `react-native` import is the react-native-tvos fork the app depends on. Without this, modules outside
      // the app (workspace packages, Bun's hoisted store) find the plain npm react-native that other workspaces pull
      // in, and the bundle mixes two React Native JS copies against one native build.
      if (moduleName === 'react-native' || moduleName.startsWith('react-native/')) {
        return context.resolveRequest({ ...context, originModulePath: path.join(__dirname, 'index.js') }, moduleName, platform);
      }
      return context.resolveRequest(context, moduleName, platform);
    }, { 'react-native-google-cast': path.join(__dirname, 'src/lib/cast/googleCast.foss.ts') })),
    nodeModulesPaths: [
      path.resolve(__dirname, 'node_modules'),
      path.resolve(repoRoot, 'node_modules'),
    ],
  },
  // The inlined SF_DEV_TICKET_KEY, SF_DEV_API_BASE_URL, SF_METADATA_TICKETS and EXPO_PUBLIC_METADATA_URL
  // (babel-plugin-dev-ticket-key.js, which also reads SF_LOCAL_METADATA) change the transformed code, so they are part of
  // the transform cache key: a cached dev-key module never lands in a production-key bundle, or the other way round.
  cacheVersion: `dev-ticket-key:${(process.env.SF_DEV_TICKET_KEY ?? '').trim()}|${(process.env.SF_DEV_API_BASE_URL ?? '').trim()}|${(process.env.SF_METADATA_TICKETS ?? '').trim()}|${(process.env.EXPO_PUBLIC_METADATA_URL ?? '').trim()}|${(process.env.SF_LOCAL_METADATA ?? '').trim()}`,
  serializer: {
    // The default resolves InitializeCore from wherever Bun hoisted a `react-native` (the plain npm package, or none),
    // not the react-native-tvos fork the app imports; two cores in one bundle crash at launch.
    getModulesRunBeforeMainModule: () => [require.resolve('react-native/setup-env', { paths: [__dirname] })],
  },
};

const merged = mergeConfig(getDefaultConfig(__dirname), config);

// Release builds whose error reports (REL-LOG-06) read as source lines: see @space/error-report/metro.
module.exports = require('@space/error-report/metro').withErrorReportSourcemaps(merged, __dirname);
