import { afterEach, describe, expect, it } from "vitest";
import { desktopClientIdentity } from "../src/clientIdentity";
import { __resetAppVersionStateForTests, clientIdentityHeaders, formatClientHeader, setClientIdentity } from "@space/shared/appVersion";

const SUITE = "desktop-client-identity";
const log = (testId: string, phase: string, data?: unknown) =>
  console.info(`[${SUITE}] ${testId} ${phase}`, data === undefined ? "" : JSON.stringify(data));

afterEach(() => __resetAppVersionStateForTests());

const header = (build: Parameters<typeof desktopClientIdentity>[0]) => {
  const identity = desktopClientIdentity(build);
  return identity ? formatClientHeader(identity) : null;
};

describe("REL-CD-29 desktop builds state version and how they were installed", () => {
  it("adds flatpak, appimage or system on Linux, windows or macos on the other two @req REL-CD-29 @req OPS-BIZ-10 @req WEB-ADMIN-39", () => {
    const testId = "linux-source";
    const base = { version: "0.1.3", packaged: true };
    const cases = [
      header({ app: "parrot", ...base, os: "linux", env: { FLATPAK_ID: "com.spacefleet.Parrot" } }),
      header({ app: "parrot", ...base, os: "linux", env: { APPIMAGE: "/home/u/Parrot.AppImage" } }),
      header({ app: "parrot", ...base, os: "linux", env: {} }),
      header({ app: "badger", version: "0.4.0", packaged: true, os: "linux", env: { FLATPAK_ID: "com.spacefleet.Badger" } }),
      header({ app: "parrot", ...base, os: "windows", env: { APPIMAGE: "/x" } }),
      header({ app: "badger", version: "0.4.0", packaged: true, os: "macos", env: {} }),
    ];
    log(testId, "headers", cases);
    expect(cases).toEqual([
      "parrot/desktop/0.1.3+flatpak",
      "parrot/desktop/0.1.3+appimage",
      "parrot/desktop/0.1.3+system",
      "badger/desktop/0.4.0+flatpak",
      "parrot/desktop/0.1.3+windows",
      "badger/desktop/0.4.0+macos",
    ]);
    log(testId, "done");
  });

  it("states nothing for a dev or e2e run @req REL-CD-29", () => {
    const testId = "unpackaged";
    const cases = [
      header({ app: "parrot", version: "0.1.3", packaged: false, os: "linux", env: { FLATPAK_ID: "x" } }),
      header({ app: "parrot", version: "0.0", packaged: true, os: "linux", env: {} }),
    ];
    log(testId, "headers", cases);
    expect(cases).toEqual([null, null]);
  });

  it("puts the identity on every API call's headers @req REL-CD-29 @req OPS-BIZ-10", () => {
    const testId = "headers";
    setClientIdentity(desktopClientIdentity({ app: "parrot", version: "0.1.3", packaged: true, os: "linux", env: { APPIMAGE: "/a" } }));
    const sent = clientIdentityHeaders();
    log(testId, "sent", sent);
    expect(sent).toEqual({ "x-space-client": "parrot/desktop/0.1.3+appimage" });
    log(testId, "done");
  });
});
