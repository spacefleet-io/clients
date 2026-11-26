// Inlines the build-time flag SF_DEV_TICKET_KEY into the bundle (META-ANON-06): `process.env.SF_DEV_TICKET_KEY` in app
// code becomes the string the build was run with ("" when unset). Set it to 1 only for a `profile` build made for
// testing against a dev stack (`SF_DEV_TICKET_KEY=1 ./gradlew :app:assembleProfile`), so that build pins the committed
// dev ticket key, like desktop's `build:test`. A release build never sets it: an Xcode Release bundle refuses it here,
// and android/app/build.gradle refuses it for any release task. metro.config.js puts the flag in Metro's cache key.
//
// Such a profile build may also name the dev stack it starts on, SF_DEV_API_BASE_URL (the guided test build,
// REL-TEST-05: `http://localhost:<lane api port>` through `adb reverse`); it is inlined only next to SF_DEV_TICKET_KEY=1,
// and "" in every other build.
//
// SF_METADATA_TICKETS ("" when unset): `on` turns anonymous tickets back on in a Metro dev build (META-ANON-06,
// metadataTicketsForBuild); a release or profile build sends tickets whatever it says. EXPO_PUBLIC_METADATA_URL: the
// metadata service the app's lookups go to. A Metro dev transform fills both from the dev stack's target where the
// shell set nothing (META-ANON-09, getMetroMetadataInline in scripts/dev-stack-lib.mjs): the dev stack's default
// production metadata target without tickets, or with SF_LOCAL_METADATA=1 tickets on and the metadata-api beside the
// API (META-ANON-08).
'use strict';

const NAME = 'SF_DEV_TICKET_KEY';
const API_NAME = 'SF_DEV_API_BASE_URL';
const TICKETS_NAME = 'SF_METADATA_TICKETS';
const METADATA_URL_NAME = 'EXPO_PUBLIC_METADATA_URL';
// REL-TEST-36: "1" in a bundle Xcode builds for the iOS or tvOS simulator (its PLATFORM_NAME), "" in every other build
// (a device archive, Android, a Metro dev server). Only such a bundle honours the release smoke's lane launch argument
// (apiConfig.ts smokeApiBaseUrl), so the TestFlight archive's bundle never can.
const SIMULATOR_NAME = 'SF_SIMULATOR_BUILD';

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
        `[sf-dev-ticket-key] no dev stack helper (scripts/dev-stack-lib.mjs): metadata lookups in this dev build fail until you set ${METADATA_URL_NAME}=<your metadata service URL>, or ${TICKETS_NAME}=on to send tickets to the metadata service beside the API`,
      );
    }
    return { url, tickets: tickets || 'off' };
  }
  const { getMetroMetadataInline } = require(DEV_STACK_LIB);
  return getMetroMetadataInline(env, { dev, ticketsName: TICKETS_NAME });
}

/** The value to inline for this build; throws when a release build sets the flag. */
function devTicketKeyValue(env) {
  const value = (env[NAME] ?? '').trim();
  if (value === '1' && env.CONFIGURATION === 'Release') {
    throw new Error(`${NAME}=1 is for dev-testing profile builds only; a Release build must pin the production ticket key`);
  }
  return value;
}

/** The dev stack a dev-testing profile build starts on; "" unless SF_DEV_TICKET_KEY=1. */
function devApiBaseUrlValue(env) {
  const value = (env[API_NAME] ?? '').trim();
  if (!value) return '';
  if (devTicketKeyValue(env) !== '1') {
    throw new Error(`${API_NAME} is for dev-testing profile builds only; set ${NAME}=1 with it`);
  }
  if (!/^https?:\/\/[^/\s]+$/i.test(value)) throw new Error(`${API_NAME} must be an http(s) origin, got "${value}"`);
  return value;
}

function devTicketKeyPlugin(api) {
  const t = api.types;
  // Babel caches a plugin's result; key it on the env it reads, so a changed flag is never served from that cache.
  api.cache.using(
    () =>
      `${process.env[NAME] ?? ''}|${process.env[API_NAME] ?? ''}|${process.env[TICKETS_NAME] ?? ''}|${process.env[METADATA_URL_NAME] ?? ''}|${process.env.SF_LOCAL_METADATA ?? ''}|${process.env.CONFIGURATION ?? ''}|${process.env.PLATFORM_NAME ?? ''}`,
  );
  const value = devTicketKeyValue(process.env);
  const apiValue = devApiBaseUrlValue(process.env);
  const simulatorValue = simulatorBuildValue(process.env);
  const metadata = metadataValues(process.env, api.env('development'));
  return {
    name: 'sf-dev-ticket-key',
    visitor: {
      MemberExpression(path) {
        if (path.matchesPattern(`process.env.${NAME}`)) path.replaceWith(t.stringLiteral(value));
        else if (path.matchesPattern(`process.env.${API_NAME}`)) path.replaceWith(t.stringLiteral(apiValue));
        else if (path.matchesPattern(`process.env.${TICKETS_NAME}`)) path.replaceWith(t.stringLiteral(metadata.tickets));
        else if (path.matchesPattern(`process.env.${METADATA_URL_NAME}`)) path.replaceWith(t.stringLiteral(metadata.url));
        else if (path.matchesPattern(`process.env.${SIMULATOR_NAME}`)) path.replaceWith(t.stringLiteral(simulatorValue));
      },
    },
  };
}

module.exports = devTicketKeyPlugin;
module.exports.devTicketKeyValue = devTicketKeyValue;
module.exports.devApiBaseUrlValue = devApiBaseUrlValue;
module.exports.simulatorBuildValue = simulatorBuildValue;
