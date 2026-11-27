// Polyfills for Hermes (React Native's JS engine).
// This file runs before all other modules via Metro's getModulesRunBeforeMainModule.
const { Buffer } = require('buffer');

global.Buffer = global.Buffer || Buffer;

if (typeof global.TextEncoder === 'undefined') {
  global.TextEncoder = class TextEncoder {
    encode(str) {
      return new Uint8Array(Buffer.from(str, 'utf-8'));
    }
  };
}
if (typeof global.TextDecoder === 'undefined') {
  global.TextDecoder = class TextDecoder {
    decode(buf) {
      return Buffer.from(buf).toString('utf-8');
    }
  };
}
