/**
 * @format
 */

// Polyfills first (require, not import, so they run before the hoisted imports below): Buffer and TextEncoder/
// TextDecoder for the shared library code, URL for the storage tunnel.
const { Buffer } = require('buffer');
global.Buffer = global.Buffer || Buffer;
if (typeof globalThis.TextEncoder === 'undefined') {
  globalThis.TextEncoder = class TextEncoder {
    encode(str) {
      return new Uint8Array(Buffer.from(str, 'utf-8'));
    }
  };
}
if (typeof globalThis.TextDecoder === 'undefined') {
  globalThis.TextDecoder = class TextDecoder {
    decode(buf) {
      return Buffer.from(buf).toString('utf-8');
    }
  };
}
// WebCrypto (crypto.subtle.digest): the storage tunnel checks every downloaded chunk's SHA-256 with it, and without it
// a download silently ends with no bytes.
require('react-native-quick-crypto').install();
// Native gestures (the drag that closes a sheet, UX-SHEET-01) before anything renders.
require('react-native-gesture-handler');
require('react-native-url-polyfill/auto');
// Opt-in error reports (REL-LOG-06): applies the stored answer before React mounts; nothing starts while it is off.
require('./src/lib/errorReports').startParrotErrorReporting();

const { AppRegistry, Platform } = require('react-native');
// Storage sizes follow this device's file manager (STOR-UNIT-01): Android and iOS count 1000-based "GB".
const { getStorageUnitBase, setStorageUnitBase, storageUnitBaseFor } = require('@space/shared/format');
setStorageUnitBase(storageUnitBaseFor(Platform.OS));
console.info(`storage.unit_base os=${Platform.OS} base=${getStorageUnitBase()}`);
const App = require('./App').default;
const { name: appName } = require('./app.json');

AppRegistry.registerComponent(appName, () => App);
