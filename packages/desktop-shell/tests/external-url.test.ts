// @req ACCT-PAY-01 REL-ENV-39
/**
 * The main process's `window.open` handler hands a URL to the operating system (`shell.openExternal`)
 * only when it is an `https:` page or a `mailto:` link; the hosted payment page opens through it.
 */
import { describe, expect, it } from "vitest";
import { isAllowedExternalUrl } from "../src/externalUrl";

const SUITE = "desktop-shell:external-url";

describe("isAllowedExternalUrl", () => {
  // @bugfix
  it("opens https pages and mailto links outside the app, and nothing else", () => {
    const cases: Array<[string, boolean]> = [
      ["https://payment.stancer.com/pi_1", true],
      ["https://spacefleet.example/help", true],
      ["mailto:support@spacefleet.example", true],
      ["http://payment.stancer.com/pi_1", false],
      ["file:///etc/passwd", false],
      ["javascript:alert(1)", false],
      ["smb://host/share", false],
      ["spacefleet://open", false],
      ["not a url", false],
      ["", false],
    ];
    for (const [url, expected] of cases) {
      console.info(`[${SUITE}] ${JSON.stringify(url)} -> ${isAllowedExternalUrl(url)}`);
      expect(isAllowedExternalUrl(url), url).toBe(expected);
    }
  });

  it("opens loopback http addresses only for an app whose API is a loopback http address (a dev stack's sign-in stand-in)", () => {
    const cases: Array<[string, string | undefined, boolean]> = [
      ["http://127.0.0.1:3091/google/authorize?state=s", "http://localhost:3000", true],
      ["http://localhost:3191/apple/authorize", "http://127.0.0.1:3100", true],
      ["http://[::1]:3091/microsoft/authorize", "http://[::1]:3000", true],
      ["http://127.0.0.1:3091/google/authorize", undefined, false],
      ["http://127.0.0.1:3091/google/authorize", "https://api.spacefleet.io", false],
      ["http://evil.example/authorize", "http://localhost:3000", false],
      ["http://127.0.0.1.evil.example/authorize", "http://localhost:3000", false],
      ["file:///etc/passwd", "http://localhost:3000", false],
      ["http://127.0.0.1:3091/google/authorize", "not a url", false],
    ];
    for (const [url, apiBaseUrl, expected] of cases) {
      console.info(`[${SUITE}] ${JSON.stringify(url)} api=${JSON.stringify(apiBaseUrl)} -> ${isAllowedExternalUrl(url, apiBaseUrl)}`);
      expect(isAllowedExternalUrl(url, apiBaseUrl), `${url} api=${apiBaseUrl}`).toBe(expected);
    }
  });
});
