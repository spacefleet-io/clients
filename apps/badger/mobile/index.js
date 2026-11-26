/**
 * @format
 */

// === POLYFILLS (must be require, not import, to run before hoisted imports) ===
const _Buffer = require('buffer').Buffer;
global.Buffer = global.Buffer || _Buffer;
if (typeof globalThis.TextEncoder === 'undefined') {
  globalThis.TextEncoder = class TextEncoder {
    encode(str) { return new Uint8Array(_Buffer.from(str, 'utf-8')); }
  };
}
if (typeof globalThis.TextDecoder === 'undefined') {
  globalThis.TextDecoder = class TextDecoder {
    decode(buf) { return _Buffer.from(buf).toString('utf-8'); }
  };
}
// crypto.subtle polyfill using react-native-quick-crypto
const quickCrypto = require('react-native-quick-crypto');
if (!globalThis.crypto) globalThis.crypto = {};
if (!globalThis.crypto.subtle) {
  globalThis.crypto.subtle = {
    async digest(algorithm, data) {
      const algo = typeof algorithm === 'string' ? algorithm : algorithm.name;
      const normalized = algo.replace('-', '').toLowerCase();
      const hash = quickCrypto.createHash(normalized);
      hash.update(_Buffer.from(data));
      return hash.digest().buffer;
    },
  };
}
// === END POLYFILLS ===

require('react-native-gesture-handler');
require('react-native-get-random-values');
require('react-native-url-polyfill/auto');

const { AppRegistry, AppState, LogBox, Platform } = require('react-native');

// Storage sizes follow this device's file manager (STOR-UNIT-01): Android, iOS and tvOS count 1000-based "GB".
const { getStorageUnitBase, setStorageUnitBase, storageUnitBaseFor } = require('@space/shared/format');
setStorageUnitBase(storageUnitBaseFor(Platform.OS));
console.info(`storage.unit_base os=${Platform.OS} base=${getStorageUnitBase()}`);

// The library store, playback and push modules emit structured diagnostics
// through console.warn (so they survive release log filtering). They are not
// warnings; keep them in logcat/Metro but out of the yellow on-device LogBox.
LogBox.ignoreLogs([/^library\./, /^playback\./, /^perf\./, /^\[pushHandler\]/, /^LibrarySync native module/]);
// On a TV the dev LogBox bar takes remote focus and traps it, and a remote cannot open or dismiss it: keep every log
// out of it there. They still reach the console (Metro, logcat, the simulator log).
if (Platform.isTV) LogBox.ignoreAllLogs();
// Dev and dev-testing profile builds log every JS-thread stall >= 100 ms (`perf.js_stall`) so sync/flush regressions
// show up in logcat. A store build never runs the sampler: its 50 ms timer would wake the JS thread for nothing (#957).
// Time in the background is not a stall: Android pauses JS timers there, so the sampler follows AppState.
require('./src/lib/jsStallSampler').startJsStallSamplerInDevBuild(undefined, {
  subscribeAppState: (listener) => {
    const subscription = AppState.addEventListener('change', (state) => listener(state === 'active'));
    return () => subscription.remove();
  },
});
// Opt-in error reports (REL-LOG-06): reads the saved answer and starts the SDK only if it is "send". Off until the
// user opts in, so a fresh install, a declined prompt or an unreadable setting initialises nothing and sends nothing.
require('./src/lib/errorReporting').startErrorReporting();
const { default: App } = require('./App');
const { name: appName } = require('./app.json');

AppRegistry.registerComponent(appName, () => App);
// Same-device sign-in (ACCT-PAIR-07): the approval activity's own root, "Let Parrot use your SpaceFleet account?".
AppRegistry.registerComponent('SiblingApproval', () => require('./src/screens/SiblingApprovalRoot').SiblingApprovalRoot);
