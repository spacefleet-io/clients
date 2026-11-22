/**
 * @level unit
 * REL-CD-29, REL-LOG-28: Badger desktop's local runtime saves the library and uploads for the app, but its API calls
 * carried no `x-space-client`, so the API logged `client: null` for them and never checked the build's version. The
 * desktop app now hands its identity over in `SF_CLIENT_IDENTITY`; the runtime sets it before any call, so the shared
 * API clients (library-db-runtime's transport, the SDK) state it.
 */
import { afterEach, describe, expect, it } from "vitest";
import { clientIdentityHeaders, setClientIdentity } from "@space/shared/appVersion";
import { applyClientIdentityFromEnv } from "../src/clientIdentity";

const SUITE = "runtime-client-identity";

afterEach(() => setClientIdentity(null));

describe(`[${SUITE}]`, () => {
  it("@req REL-CD-29[badger-desktop] @req REL-LOG-28[api] states the build named in SF_CLIENT_IDENTITY on its API calls", () => {
    const identity = applyClientIdentityFromEnv({ SF_CLIENT_IDENTITY: "badger/desktop/0.2.3+appimage" });
    console.info(`[${SUITE}] identity=${JSON.stringify(identity)} headers=${JSON.stringify(clientIdentityHeaders())}`);
    expect(identity).toEqual({ app: "badger", platform: "desktop", version: "0.2.3+appimage" });
    expect(clientIdentityHeaders()).toEqual({ "x-space-client": "badger/desktop/0.2.3+appimage" });
  });

  it("@req REL-CD-29[badger-desktop] states nothing when the variable is missing or malformed", () => {
    for (const value of [undefined, "", "badger/desktop", "not a header", "kodi/desktop/1.0.0/extra"]) {
      expect(applyClientIdentityFromEnv({ SF_CLIENT_IDENTITY: value })).toBeNull();
      expect(clientIdentityHeaders()).toEqual({});
    }
  });
});
