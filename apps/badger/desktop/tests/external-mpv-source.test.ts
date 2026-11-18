import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("../src/main/externalMpv.ts", import.meta.url),
  "utf8"
);

const clientSource = readFileSync(
  new URL("../src/main/mpvSocketClient.ts", import.meta.url),
  "utf8"
);

const envelopesSource = readFileSync(
  new URL("../../../../packages/mpv-protocol/src/envelopes.ts", import.meta.url),
  "utf8"
);

// On a missing-token failure, dump which expected wiring token is absent from
// which source file so the CI log pinpoints the regressed end of the bridge.
const dumpExternalMpvSnapshot = (
  label: string,
  expectations: Array<{ file: string; token: string; present: boolean }>
) => {
  try {
    console.error(`=== [external-mpv-source:${label}] snapshot ===`);
    console.error(
      `source lengths: externalMpv=${source.length} mpvSocketClient=${clientSource.length} envelopes=${envelopesSource.length}`
    );
    const missing = expectations.filter((e) => !e.present);
    console.error(`expectations: total=${expectations.length} missing=${missing.length}`);
    console.error(`missing tokens:\n${JSON.stringify(missing, null, 2)}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("external mpv osc action bridge", () => {
  it("passes a sf actions file into the shipped osc script and forwards next-episode actions back to the renderer", () => {
    console.info(
      `[external-mpv-source:setup] sources loaded externalMpv=${source.length} mpvSocketClient=${clientSource.length} envelopes=${envelopesSource.length}`
    );
    // externalMpv.ts wires the launch flow: it bakes sf-actions_file into the
    // mpv --script-opts and forwards parsed osc-action events back to the
    // renderer via webContents.send.
    // Tier-4 retired the per-event sf-mpv-external-osc-action channel and
    // multiplexed it through sf-mpv-external-message with `type: "osc_action"`.
    // Post Tier-3: the OSC poller + oscActionFileSchema validation live inside
    // UnixSocketMpvClient. Track each token so a failure dumps exactly which
    // end of the wiring regressed rather than only the first failing expect().
    const expectations = [
      { file: "externalMpv", token: "sf-actions_file=", present: source.includes("sf-actions_file=") },
      { file: "externalMpv", token: "sf-mpv-external-message", present: source.includes("sf-mpv-external-message") },
      { file: "externalMpv", token: 'type: "osc_action"', present: source.includes('type: "osc_action"') },
      { file: "mpvSocketClient", token: "startOscActionPolling", present: clientSource.includes("startOscActionPolling") },
      { file: "mpvSocketClient", token: "oscActionFileSchema", present: clientSource.includes("oscActionFileSchema") },
      { file: "envelopes", token: 'z.literal("next_episode")', present: envelopesSource.includes('z.literal("next_episode")') },
    ];
    console.info(
      `[external-mpv-source:assert] token presence=${JSON.stringify(expectations.map((e) => ({ [`${e.file}:${e.token}`]: e.present })))}`
    );
    if (expectations.some((e) => !e.present))
      dumpExternalMpvSnapshot("osc-action-bridge", expectations);

    expect(source).toContain("sf-actions_file=");
    expect(source).toContain("sf-mpv-external-message");
    expect(source).toContain('type: "osc_action"');
    expect(clientSource).toContain("startOscActionPolling");
    expect(clientSource).toContain("oscActionFileSchema");
    expect(envelopesSource).toContain('z.literal("next_episode")');
  });
});
