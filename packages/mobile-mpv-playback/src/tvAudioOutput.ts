/**
 * TV audio output (MPV-TV-03): which compressed formats go to the TV / receiver untouched (mpv `audio-spdif`) and how many
 * channels decoded sound may use (mpv `audio-channels`), from what the box reports about its audio sink.
 * Pure: no React, no native. The native side only reads the raw facts (`TvAudioReport`: Android `AudioManager` /
 * `AudioTrack`, tvOS `AVAudioSession`) and applies the plan (`MpvControl.setAudioOutput`), which logs it.
 *
 * Android TV / Fire TV: the app uses mpv's `audiotrack` output there (`opensles` is stereo only and has no passthrough).
 * mpv's `audiotrack` sends every passthrough format as IEC 61937 over a STEREO AudioTrack (`ao_audiotrack.c`, `init`:
 * `channel_config = CHANNEL_OUT_STEREO` for `ENCODING_IEC61937`), which carries Dolby Digital, Dolby Digital Plus and
 * DTS core but not the 8-channel high-bit-rate stream TrueHD and DTS-HD need; so those two are always decoded to
 * multichannel PCM, even when the sink reports them.
 *
 * Apple TV: no app can pass audio through (only Apple's own player can), so nothing is sent untouched; mpv's `audiounit`
 * output asks `AVAudioSession` for as many channels as the layout needs, up to `maximumOutputNumberOfChannels`.
 */

/** Passthrough formats mpv's `audiotrack` output can carry, in mpv `audio-spdif` names. */
export const ANDROID_PASSTHROUGH_FORMATS = ["ac3", "eac3", "dts"] as const;
export type PassthroughFormat = (typeof ANDROID_PASSTHROUGH_FORMATS)[number];

/** One output device as Android lists it (`AudioManager.getDevices(GET_DEVICES_OUTPUTS)`). */
export type AndroidAudioDevice = {
  /** `hdmi`, `hdmi_arc`, `hdmi_earc`, `speaker`, `bluetooth`, `usb`, `other`. */
  type: string;
  /** Encodings the device declares (`AudioDeviceInfo.getEncodings`), as `ac3` / `eac3` / `eac3_joc` / `dts` / `dts_hd` / `truehd` / `pcm`; empty = not declared. */
  encodings: string[];
  /** Channel counts the device declares (`getChannelCounts`); empty = not declared. */
  channelCounts: number[];
};

export type TvAudioReport =
  | {
      platform: "android";
      sdk: number;
      devices: AndroidAudioDevice[];
      /** The last `ACTION_HDMI_AUDIO_PLUG` broadcast (sticky): null when the box never sent one. */
      hdmiPlug: { plugged: boolean; encodings: string[]; maxChannels: number } | null;
      /** Encodings `AudioTrack.isDirectPlaybackSupported` accepts (48 kHz, stereo mask: the IEC 61937 track mpv opens); null below API 29. */
      direct: string[] | null;
    }
  | {
      platform: "tvos" | "ios";
      /** `AVAudioSession.maximumOutputNumberOfChannels` of the current route. */
      maxOutputChannels: number;
      /** `currentRoute.outputs[].portType` (e.g. `HDMIOutput`). */
      outputPorts: string[];
    };

export type TvAudioPlan = {
  /** mpv `audio-spdif`: comma list, "" = decode everything. */
  spdif: string;
  /** mpv `audio-channels`: a layout list mpv picks the best fit from, or `auto-safe` (mpv's default). */
  channels: string;
  /** tvOS: channels to request from `AVAudioSession` (`setPreferredOutputNumberOfChannels`); null elsewhere. */
  preferredOutputChannels: number | null;
  /** Why: what the report said, for the native log line. */
  reason: string;
};
const HDMI_TYPES: Record<string, true> = { hdmi: true, hdmi_arc: true, hdmi_earc: true };

/** Layout list for up to [max] channels: 8 -> 7.1, 6 -> 5.1, else stereo; 0 (unknown) keeps mpv's default. */
const channelsFor = (max: number): string => {
  if (max >= 8) return "7.1,5.1,stereo";
  if (max >= 6) return "5.1,stereo";
  if (max > 0) return "stereo";
  return "auto-safe";
};

export const planTvAudioOutput = (report: TvAudioReport): TvAudioPlan => {
  if (report.platform !== "android") {
    const max = Math.max(0, Math.floor(report.maxOutputChannels));
    const preferred = max > 0 ? Math.min(max, 8) : null;
    return {
      spdif: "",
      channels: channelsFor(max),
      preferredOutputChannels: preferred,
      reason: `${report.platform} max-output-channels=${max} ports=${report.outputPorts.join("+") || "none"} passthrough=unavailable`,
    };
  }
  const sinks = report.devices.filter((d) => HDMI_TYPES[d.type] === true);
  const plug = report.hdmiPlug?.plugged ? report.hdmiPlug : null;
  // API 29+: what the audio stack will really open for an AudioTrack wins; below that, what the HDMI sink declares.
  const accepted = new Set(report.direct ?? [...sinks.flatMap((d) => d.encodings), ...(plug?.encodings ?? [])]);
  const spdif = ANDROID_PASSTHROUGH_FORMATS.filter((f) => accepted.has(f));
  const maxChannels = Math.max(0, plug?.maxChannels ?? 0, ...sinks.flatMap((d) => d.channelCounts));
  const source = report.direct ? "direct-playback" : sinks.length > 0 || plug ? "hdmi-declared" : "no-hdmi-sink";
  return {
    spdif: spdif.join(","),
    channels: channelsFor(maxChannels),
    preferredOutputChannels: null,
    reason: `android sdk=${report.sdk} source=${source} sinks=${sinks.map((d) => d.type).join("+") || "none"} accepted=${[...accepted].sort().join("+") || "none"} max-channels=${maxChannels}`,
  };
};

type AudioOutputNative = {
  getAudioOutputReport: () => Promise<TvAudioReport>;
  setAudioOutput: (spdif: string, channels: string, preferredOutputChannels: number, reason: string) => Promise<boolean>;
};

/**
 * Reads the sink, plans and applies (TV only, before the first file loads). Never throws: a failed read or apply leaves
 * mpv's defaults (stereo-safe decoded sound), which is what a box without the native calls had before.
 */
export const configureTvAudioOutput = async (native: AudioOutputNative): Promise<TvAudioPlan | null> => {
  try {
    const report = await native.getAudioOutputReport();
    const plan = planTvAudioOutput(report);
    console.info("[tvAudioOutput] plan", JSON.stringify({ report, plan }));
    await native.setAudioOutput(plan.spdif, plan.channels, plan.preferredOutputChannels ?? 0, plan.reason);
    return plan;
  } catch (error) {
    console.warn("[tvAudioOutput] failed, mpv defaults kept", JSON.stringify({ error: String(error) }));
    return null;
  }
};
