// jsdom has no Web Audio: the player's engine (PAR-PLAY-03) gets a silent stand-in whose decoding always fails, so
// in unit tests every song plays from the engine's <audio> element (whose play/pause the tests stub).
class SilentParam {
  value = 1;
  setValueAtTime() {}
  linearRampToValueAtTime() {}
  setTargetAtTime() {}
  cancelScheduledValues() {}
}
class SilentNode {
  gain = new SilentParam();
  buffer = null;
  onended = null;
  connect() {}
  disconnect() {}
  start() {}
  stop() {}
}
class SilentAudioContext {
  currentTime = 0;
  state = "running";
  destination = new SilentNode();
  createGain = () => new SilentNode();
  createBufferSource = () => new SilentNode();
  createMediaElementSource = () => new SilentNode();
  decodeAudioData = () => Promise.reject(new Error("no Web Audio in jsdom"));
  resume = () => Promise.resolve();
  suspend = () => Promise.resolve();
}
if (typeof window !== "undefined" && !("AudioContext" in window)) {
  Object.assign(window, { AudioContext: SilentAudioContext });
  Object.assign(globalThis, { AudioContext: SilentAudioContext });
}
