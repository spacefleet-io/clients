// Inlines build-time values into the bundle; React Native has no `process.env` at run time.
// - `process.env.PARROT_API_BASE_URL` becomes the string the build was run with ("" when unset, so the app talks to the
//   production API). Set it only for a build made to test against a dev stack
//   (`PARROT_API_BASE_URL=http://10.0.2.2:3001 ./gradlew :app:assembleRelease`); the Play build never sets it.
// - `process.env.PARROT_METADATA_TICKETS` ("" when unset): `on` turns anonymous tickets back on in a Metro dev build
//   (META-ANON-06); a release build sends tickets whatever it says.
// - `process.env.EXPO_PUBLIC_METADATA_URL`: the metadata service the app's lookups go to. A Metro dev transform fills it
//   and the tickets flag from the dev stack's target where the shell set nothing (META-ANON-09, getMetroMetadataInline
//   in scripts/dev-stack-lib.mjs): the dev stack's default production metadata target without tickets, or with
//   SF_LOCAL_METADATA=1 tickets on and the metadata-api beside the API (META-ANON-08).
// - `process.env.SF_SIMULATOR_BUILD` (REL-TEST-36): "1" in a bundle Xcode builds for the iOS or tvOS simulator (its
//   PLATFORM_NAME), "" in every other build (a device archive for TestFlight, Android). Only a simulator bundle honours
//   the release smoke's `-SFSmokeApiBaseUrl` loopback lane (src/config.ts), so a TestFlight or App Store build talks
//   to production only (ACCT-AUTH-09). Same flag and rule as Badger's babel-plugin-dev-ticket-key.js.
// metro.config.js puts every value it reads in Metro's cache key.
'use strict';

const API_NAME = 'PARROT_API_BASE_URL';
const TICKETS_NAME = 'PARROT_METADATA_TICKETS';
const METADATA_URL_NAME = 'EXPO_PUBLIC_METADATA_URL';
const SIMULATOR_NAME = 'SF_SIMULATOR_BUILD';
const READ = [API_NAME, TICKETS_NAME, METADATA_URL_NAME, 'SF_LOCAL_METADATA', 'PLATFORM_NAME'];

/** "1" when Xcode bundles for a simulator SDK, "" otherwise. */
function simulatorBuildValue(env) {
  return /^(iphonesimulator|appletvsimulator)$/.test((env.PLATFORM_NAME ?? '').trim()) ? '1' : '';
}

const DEV_STACK_LIB = require('node:path').join(__dirname, '../../../scripts/dev-stack-lib.mjs');
let warnedNoDevStack = false;

/**
 * The metadata URL and tickets flag to inline; a dev transform loads the dev stack's helper (Node >= 20.19). Without it
 * (a checkout of the public client repository) a dev transform inlines only what the shell set, tickets "off" by
 * default, and says what to set: with no URL and tickets off, the first lookup fails in metadata-client.
 */
function metadataValues(env, dev) {
  const url = (env[METADATA_URL_NAME] ?? '').trim();
  const tickets = (env[TICKETS_NAME] ?? '').trim();
  if (!dev) return { url, tickets };
  if (!require('node:fs').existsSync(DEV_STACK_LIB)) {
    if (!url && tickets !== 'on' && !warnedNoDevStack) {
      warnedNoDevStack = true;
      console.warn(
        `[parrot-api-base-url] no dev stack helper (scripts/dev-stack-lib.mjs): metadata lookups in this dev build fail until you set ${METADATA_URL_NAME}=<your metadata service URL>, or ${TICKETS_NAME}=on to send tickets to the metadata service beside the API`,
      );
    }
    return { url, tickets: tickets || 'off' };
  }
  const { getMetroMetadataInline } = require(DEV_STACK_LIB);
  return getMetroMetadataInline(env, { dev, ticketsName: TICKETS_NAME });
}

module.exports = function apiBaseUrlPlugin(api) {
  const t = api.types;
  // Babel caches a plugin's result; key it on the env it reads, so a changed value is never served from that cache.
  api.cache.using(() => READ.map((name) => process.env[name] ?? '').join('\n'));
  const metadata = metadataValues(process.env, api.env('development'));
  const values = [
    [API_NAME, (process.env[API_NAME] ?? '').trim()],
    [TICKETS_NAME, metadata.tickets],
    [METADATA_URL_NAME, metadata.url],
    [SIMULATOR_NAME, simulatorBuildValue(process.env)],
  ];
  return {
    name: 'parrot-api-base-url',
    visitor: {
      MemberExpression(path) {
        for (const [name, value] of values) {
          if (path.matchesPattern(`process.env.${name}`)) {
            path.replaceWith(t.stringLiteral(value));
            return;
          }
        }
      },
    },
  };
};

module.exports.simulatorBuildValue = simulatorBuildValue;
