/**
 * REL-FAM-03: Badger's `badger:` and Parrot's `parrot:` links share one implementation (`createAppLinks`): found in a
 * command line however each OS / launcher shapes it, classified as a provider sign-in return (ACCT-SIGNIN-05), a
 * payment return (ACCT-PAY-05) or anything else, and registered with the OS only by the running (primary) app outside
 * tests, with the dev "argv[1] is the link" guard.
 */
import { describe, expect, it, vi } from "vitest";
import { createAppLinks, describeAppLink, type AppLink } from "../src/main-shell/appLinks";

const dump = (label: string, value: unknown) => console.info(`[app-links:${label}] state`, JSON.stringify(value));

const PAY = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const CODE = "AbCdEfGhIjKlMnOpQrStUv_-0123";

for (const scheme of ["badger", "parrot"] as const) {
  const other = scheme === "badger" ? "parrot" : "badger";
  const links = createAppLinks(scheme);

  describe(`${scheme}: find`, () => {
    const cases: Array<{ name: string; argv: unknown[]; expected: string | null }> = [
      { name: "windows packaged", argv: ["C:\\Program Files\\App\\App.exe", `${scheme}://start`], expected: `${scheme}://start` },
      { name: "linux packaged", argv: ["/opt/App/app", `${scheme}://start`], expected: `${scheme}://start` },
      {
        name: "dev electron, switches before the link",
        argv: ["/x/node_modules/electron/dist/electron", "/x/out/main/index.js", "--allow-file-access-from-files", "--no-sandbox", `${scheme}://start`],
        expected: `${scheme}://start`,
      },
      { name: "quoted (windows shell)", argv: ["App.exe", `"${scheme}://start"`], expected: `${scheme}://start` },
      { name: "uppercase scheme", argv: ["app", `${scheme.toUpperCase()}://start`], expected: `${scheme.toUpperCase()}://start` },
      { name: "the other app's link", argv: ["app", `${other}://start`], expected: null },
      { name: "no link", argv: ["app", "--inspect", "/home/u/app"], expected: null },
      { name: "non-string entries", argv: [undefined, 42, null, { href: `${scheme}://x` }], expected: null },
    ];
    for (const testCase of cases) {
      // @req REL-FAM-03
      it(`@req REL-FAM-03 finds the link: ${testCase.name}`, () => {
        const found = links.find(testCase.argv);
        dump("find", { scheme, name: testCase.name, found });
        expect(found).toBe(testCase.expected);
      });
    }
  });

  describe(`${scheme}: classify`, () => {
    // @req ACCT-SIGNIN-05
    it("@req ACCT-SIGNIN-05 reads a provider sign-in return: a code, a known error, or invalid_code", () => {
      const results = {
        code: links.classify(`${scheme}://auth/provider?signinCode=${CODE}`),
        error: links.classify(`${scheme}://auth/provider?signinError=email_unverified`),
        unknownError: links.classify(`${scheme}://auth/provider?signinError=boom`),
        badCode: links.classify(`${scheme}://auth/provider?signinCode=short`),
        empty: links.classify(`${scheme}://auth/provider`),
        otherPath: links.classify(`${scheme}://auth/other?signinCode=${CODE}`).kind,
      };
      dump("classify-provider", { scheme, results });
      expect(results).toEqual({
        code: { kind: "provider-return", link: `${scheme}://auth/provider?signinCode=${CODE}`, outcome: { code: CODE } },
        error: { kind: "provider-return", link: `${scheme}://auth/provider?signinError=email_unverified`, outcome: { error: "email_unverified" } },
        unknownError: { kind: "provider-return", link: `${scheme}://auth/provider?signinError=boom`, outcome: { error: "provider_failed" } },
        badCode: { kind: "provider-return", link: `${scheme}://auth/provider?signinCode=short`, outcome: { error: "invalid_code" } },
        empty: { kind: "provider-return", link: `${scheme}://auth/provider`, outcome: { error: "invalid_code" } },
        otherPath: "other",
      });
    });

    // @req ACCT-PAY-05
    it("@req ACCT-PAY-05 reads a payment return with a UUID id; anything else of the scheme is `other`", () => {
      const results = {
        payment: links.classify(`${scheme}://billing/return?payment=${PAY}`),
        badId: links.classify(`${scheme}://billing/return?payment=../x`).kind,
        start: links.classify(`${scheme}://start`).kind,
        otherApp: links.classify(`${other}://billing/return?payment=${PAY}`).kind,
      };
      dump("classify-payment", { scheme, results });
      expect(results).toEqual({
        payment: { kind: "payment-return", link: `${scheme}://billing/return?payment=${PAY}`, paymentId: PAY },
        badId: "other",
        start: "other",
        otherApp: "other",
      });
    });

    // @req ACCT-SIGNIN-05
    it("@req ACCT-SIGNIN-05 classifies a second launch's argv, and names a link in a log line without its code", () => {
      const argv = ["/opt/App/app", "--no-sandbox", `"${scheme}://auth/provider?signinCode=${CODE}"`];
      const fromArgv = links.fromArgv(argv);
      const described = fromArgv === null ? null : describeAppLink(fromArgv);
      const plain = links.fromArgv(["/opt/App/app"]);
      const payment: AppLink = { kind: "payment-return", link: "x", paymentId: PAY };
      dump("from-argv", { scheme, fromArgv: fromArgv?.kind, described, plain, payment: describeAppLink(payment) });
      expect(fromArgv).toEqual({ kind: "provider-return", link: `${scheme}://auth/provider?signinCode=${CODE}`, outcome: { code: CODE } });
      expect(described).toBe("provider-return code");
      expect(described).not.toContain(CODE);
      expect(plain).toBeNull();
      expect(describeAppLink(payment)).toBe(`payment-return ${PAY}`);
      expect(describeAppLink({ kind: "other", link: `${scheme}://start?secret=1` })).toBe("other");
    });
  });

  describe(`${scheme}: register`, () => {
    const base = { env: {}, defaultApp: true, execPath: "/x/electron", resolvePath: (path: string) => `/abs/${path}` };

    // @req PLAT-DESK-14
    it("@req PLAT-DESK-14 a dev run registers Electron plus its main script; a dev run started by a link registers the app", () => {
      console.info(`[app-links:register] phase: dev ${scheme}`);
      const devApp = { setAsDefaultProtocolClient: vi.fn(() => true) };
      const dev = links.register({ ...base, app: devApp, primary: true, argv: ["/x/electron", "out/main/index.js"] });
      console.info(`[app-links:register] phase: dev started by a link ${scheme}`);
      const linkApp = { setAsDefaultProtocolClient: vi.fn(() => true) };
      const devLink = links.register({ ...base, app: linkApp, primary: true, argv: ["/x/electron", `${scheme}://start`] });
      dump("register-dev", { scheme, dev, devLink, devCalls: devApp.setAsDefaultProtocolClient.mock.calls, linkCalls: linkApp.setAsDefaultProtocolClient.mock.calls });
      expect(dev).toEqual({ registered: true, args: [scheme, "/x/electron", ["/abs/out/main/index.js"]] });
      expect(devApp.setAsDefaultProtocolClient).toHaveBeenCalledWith(scheme, "/x/electron", ["/abs/out/main/index.js"]);
      expect(devLink).toEqual({ registered: true, args: [scheme] });
      expect(linkApp.setAsDefaultProtocolClient).toHaveBeenCalledWith(scheme);
    });

    // @req REL-FAM-03
    it("@req REL-FAM-03 never registers in tests (SF_E2E=1) or from a launch that handed over to the running app", () => {
      const app = { setAsDefaultProtocolClient: vi.fn(() => true) };
      const e2e = links.register({ ...base, app, primary: true, env: { SF_E2E: "1" }, argv: ["/x/electron", "out/main/index.js"] });
      const secondary = links.register({ ...base, app, primary: false, argv: ["/x/electron", "out/main/index.js"] });
      const packaged = links.register({ ...base, app, primary: true, defaultApp: false, execPath: "/opt/app", argv: ["/opt/app"] });
      dump("register-skips", { scheme, e2e, secondary, packaged, calls: app.setAsDefaultProtocolClient.mock.calls });
      expect(e2e).toEqual({ skipped: "e2e" });
      expect(secondary).toEqual({ skipped: "not-primary" });
      expect(packaged).toEqual({ registered: true, args: [scheme] });
      expect(app.setAsDefaultProtocolClient).toHaveBeenCalledTimes(1);
    });
  });
}
