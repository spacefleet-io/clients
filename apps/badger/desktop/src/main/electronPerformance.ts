type DesktopEnv = Record<string, string | undefined>;

const isEnabled = (value: string | undefined) => value?.trim() === "1";
const isDisabled = (value: string | undefined) => value?.trim() === "0";

export const shouldDisableHardwareAcceleration = (env: DesktopEnv) =>
  isEnabled(env.SF_ELECTRON_DISABLE_HARDWARE_ACCELERATION);

export const shouldDisableSpellcheck = (env: DesktopEnv) =>
  !isEnabled(env.SF_ELECTRON_ENABLE_SPELLCHECK) && !isDisabled(env.SF_ELECTRON_DISABLE_SPELLCHECK);

export const getElectronCommandLineSwitches = (env: DesktopEnv) => {
  const switches: string[] = [];
  if (isEnabled(env.SF_ELECTRON_ENABLE_GPU_RASTERIZATION)) {
    switches.push("enable-gpu-rasterization");
  }
  if (isEnabled(env.SF_ELECTRON_ENABLE_ZERO_COPY)) {
    switches.push("enable-zero-copy");
  }
  if (isEnabled(env.SF_ELECTRON_ENABLE_ACCELERATED_VIDEO_DECODE)) {
    switches.push("enable-accelerated-video-decode");
  }
  return switches;
};
