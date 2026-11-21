// @req OFFL-SAFE-02[badger-desktop]
//
// An offline save the runtime refused at the start of its download step (not enough free disk space) fails its job with
// `OFFLINE_INSUFFICIENT_DISK_SPACE:<required>:<free>`. The jobs sidebar turns that back into the same sentence the
// download prompt shows, in the interface language; every other error leaves the row as it was.

import { describe, expect, it, vi } from "vitest";
import type { TFunction } from "i18next";
import { offlineDiskSpaceErrorMessage } from "@space/shared/offlineDiskSpace";
import en from "../src/renderer/src/i18n/en.json";
import fr from "../src/renderer/src/i18n/fr.json";
import { offlineDiskSpaceJobMessage } from "../src/renderer/src/lib/offlineDiskSpaceLabel";

const SUITE = "offline-disk-space-job-message";
const GB = 1_000_000_000;

/** Interpolates the real locale string, as i18next does for {{name}}. */
const tFor = (bundle: typeof en) =>
  ((key: string, params: Record<string, string>) => {
    const template = key
      .split(".")
      .reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], bundle) as string;
    return template.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => params[name] ?? `{{${name}}}`);
  }) as unknown as TFunction;

describe("offlineDiskSpaceJobMessage", () => {
  it("states the space needed and free for a disk-space refusal (en)", () => {
    const error = offlineDiskSpaceErrorMessage(5 * GB, 1 * GB);
    const message = offlineDiskSpaceJobMessage(error, tFor(en), () => "en");
    console.info(`[${SUITE}:en] error=${error} message=${message}`);
    expect(message).toMatch(/^Not enough free disk space \(5(\.0)? GB needed, 1(\.0)? GB free\)\.$/);
  });

  it("speaks the interface language (fr)", () => {
    const error = offlineDiskSpaceErrorMessage(5 * GB, 1 * GB);
    const message = offlineDiskSpaceJobMessage(error, tFor(fr as typeof en), () => "fr");
    console.info(`[${SUITE}:fr] message=${message}`);
    expect(message).toContain("Espace disque insuffisant");
    expect(message).not.toContain("{{");
  });

  it("leaves every other error alone and never reads the language for it", () => {
    const locale = vi.fn(() => "en");
    const results = [undefined, "", "handler-error", "OFFLINE_INSUFFICIENT_DISK_SPACE:abc:1"].map((error) =>
      offlineDiskSpaceJobMessage(error, tFor(en), locale),
    );
    console.info(`[${SUITE}:other] results=${JSON.stringify(results)} localeCalls=${locale.mock.calls.length}`);
    expect(results).toEqual([null, null, null, null]);
    expect(locale).not.toHaveBeenCalled();
  });
});
