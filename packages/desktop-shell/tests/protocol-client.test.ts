/**
 * The `setAsDefaultProtocolClient` arguments of Badger's and Parrot's link schemes: a dev run registers Electron plus
 * its main script, a packaged app (or a dev run started by a link) registers itself.
 */
import { describe, expect, it } from "vitest";
import { protocolClientArgs } from "../src/main-shell/protocolClient";

const resolvePath = (path: string) => `/abs/${path}`;

describe("protocolClientArgs", () => {
  for (const scheme of ["badger", "parrot"]) {
    it(`${scheme}: registers the Electron binary plus the main script in dev`, () => {
      const args = protocolClientArgs(scheme, { defaultApp: true, execPath: "/x/electron", argv: ["/x/electron", "out/main/index.js"], resolvePath });
      expect(args).toEqual([scheme, "/x/electron", ["/abs/out/main/index.js"]]);
    });

    it(`${scheme}: registers the app itself when packaged, or when the dev argv[1] is the link`, () => {
      const packaged = protocolClientArgs(scheme, { defaultApp: false, execPath: "/opt/app", argv: ["/opt/app", `${scheme}://start`], resolvePath });
      const devLink = protocolClientArgs(scheme, {
        defaultApp: true,
        execPath: "/x/electron",
        argv: ["/x/electron", ` ${scheme.toUpperCase()}://billing/return?payment=p1`],
        resolvePath,
      });
      expect(packaged).toEqual([scheme]);
      expect(devLink).toEqual([scheme]);
    });
  }

  it("registers the app itself when a dev run has no main script", () => {
    expect(protocolClientArgs("parrot", { defaultApp: true, execPath: "/x/electron", argv: ["/x/electron"], resolvePath })).toEqual(["parrot"]);
  });
});
