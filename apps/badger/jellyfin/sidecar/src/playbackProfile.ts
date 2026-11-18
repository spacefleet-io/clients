/**
 * STOR-BW-11 (badger-jellyfin): every playback tunnel session (video and subtitle reads alike) and every traffic read names the
 * followed profile (INTG-PROF-01). Applied at the tunnel client's fetch, so it holds whether or not the shared client also sends
 * it from `getProfileId`; a profileId already present is left alone.
 */
type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const PROFILE_FIELD = "profileId";

export const withPlaybackProfile = (getProfileId: () => string | null, fetchImpl: Fetch = (input, init) => globalThis.fetch(input, init)): Fetch =>
  (async (input: Parameters<Fetch>[0], init?: RequestInit) => {
    const profileId = getProfileId();
    if (!profileId) return fetchImpl(input, init);
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (method === "POST" && url.pathname.endsWith("/storage/tunnel/session") && typeof init?.body === "string") {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      if ((body.purpose ?? "playback") === "playback" && !body[PROFILE_FIELD]) {
        return fetchImpl(input, { ...init, body: JSON.stringify({ ...body, [PROFILE_FIELD]: profileId }) });
      }
    }
    if (method === "GET" && url.pathname.endsWith("/storage/traffic") && !url.searchParams.has(PROFILE_FIELD)) {
      url.searchParams.set(PROFILE_FIELD, profileId);
      return fetchImpl(input instanceof Request ? new Request(url.toString(), input) : url.toString(), init);
    }
    return fetchImpl(input, init);
  }) as Fetch;
