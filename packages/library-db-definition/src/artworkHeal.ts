/**
 * STOR-PLACE-09: artwork of a media still in the library whose encrypted copy is gone from the user's storage is
 * fetched back from the metadata service, encrypted, stored again and swapped into the library, so the library
 * never shows a broken picture.
 *
 * Platform-neutral (desktop, phone, TV): the app supplies how to check storage, read the library, fetch details and
 * images, encrypt + upload, and write the new reference. Only a definite "not found" from the storage existence
 * check (`exists[key] === false`) starts a heal: a failed check, a gateway error or a failed download never does.
 */
import { artworkStorageKey } from "./mediaDetails";

export type ArtworkHealTarget = "mediaPoster" | "mediaBackdrop" | "seasonPoster" | "personProfile" | "episodeStill";
export type ArtworkHealKind = "poster" | "backdrop" | "profile" | "still";

export const ARTWORK_HEAL_KIND_BY_TARGET: Record<ArtworkHealTarget, ArtworkHealKind> = {
  mediaPoster: "poster",
  mediaBackdrop: "backdrop",
  seasonPoster: "poster",
  personProfile: "profile",
  episodeStill: "still",
};

type HealablePerson = { personId: string; tmdbId: number | null; profilePath?: string | null };

/** The library's view of one media: the parts of `MediaDetails` that carry artwork. */
export type HealableMedia = {
  id: string;
  type: "movie" | "tv";
  tmdbId: number | null;
  originalLanguage?: string | null;
  posterPath?: string | null;
  backdropPath?: string | null;
  seasons?: { id: string; seasonNumber: number; posterPath?: string | null }[];
  episodes?: { id: string; seasonNumber: number; episodeNumber: number; stillPath?: string | null }[];
  cast?: HealablePerson[];
  crew?: HealablePerson[];
};

/** Metadata-service details of the same media (TMDB image paths). */
export type HealSourceDetails = {
  posterPath?: string | null;
  backdropPath?: string | null;
  seasons?: { seasonNumber: number; posterPath?: string | null }[];
  episodes?: { seasonNumber: number; episodeNumber: number; stillPath?: string | null }[];
  cast?: { tmdbId: number | null; profilePath?: string | null }[];
  crew?: { tmdbId: number | null; profilePath?: string | null }[];
};

/** One library slot holding a stored artwork reference (`asset:<type>::<key>` or a bare key). */
export type ArtworkHealSlot = {
  mediaId: string;
  target: ArtworkHealTarget;
  /** Row id: the media id, season id, episode id or person id. */
  id: string;
  ref: string;
  key: string;
  kind: ArtworkHealKind;
  seasonNumber?: number;
  episodeNumber?: number;
  personTmdbId?: number | null;
};

/** A compare-and-set swap: written only while the slot still holds `path` (the broken reference). */
export type ArtworkRefChange = { target: ArtworkHealTarget; id: string; path: string; value: string };

export type FetchedArtwork = { bytes: Uint8Array; contentType: string };

export type ArtworkHealLog = (event: string, detail: Record<string, unknown>) => void;

export type ArtworkHealerDeps = {
  /** Existence of storage keys. MUST throw on any gateway or network failure: only `false` means "not found". */
  exists(keys: string[]): Promise<Record<string, boolean>>;
  /** Ids of every media in the library. */
  listMediaIds(): Promise<string[]>;
  /** The media as the library holds it now; null when it is no longer in the library. */
  loadMedia(mediaId: string): Promise<HealableMedia | null>;
  /** Details from the metadata service (anonymous ticket path, TMDB id only); null when unavailable. */
  fetchDetails(media: HealableMedia): Promise<HealSourceDetails | null>;
  /** One image through the metadata service; null when unavailable. */
  fetchImage(kind: ArtworkHealKind, path: string): Promise<FetchedArtwork | null>;
  /** Encrypts and uploads the image under a new key; returns the new library reference. */
  store(image: FetchedArtwork, slot: ArtworkHealSlot): Promise<string>;
  /** Writes the swaps (compare-and-set); returns how many were applied. */
  replaceRefs(mediaId: string, changes: ArtworkRefChange[]): Promise<number>;
  onHealed?(mediaId: string, changes: ArtworkRefChange[]): void;
  log?: ArtworkHealLog;
  now?(): number;
  sleep?(ms: number): Promise<void>;
  /** Images fetched back per rolling minute (default 30). */
  maxImagesPerMinute?: number;
  /** A key whose heal failed (or was found present) is not tried again for this long (default 15 min). */
  cooldownMs?: number;
  /** The key → slot index of the library is rebuilt on a miss at most this often (default 5 min). */
  indexMaxAgeMs?: number;
};

export type ArtworkSweepResult = { checked: number; missing: number; healed: number; aborted: boolean };

export type ArtworkHealer = {
  /**
   * A display path failed to download `ref`. Confirms the object is gone, finds the media using it and heals it.
   * Resolves to the new reference, or null when nothing was healed (present, check failed, not in the library...).
   */
  reportMissing(ref: string): Promise<string | null>;
  /** Checks every stored artwork of the library in batches and heals what is missing. */
  sweep(): Promise<ArtworkSweepResult>;
  /** The new reference of a key healed this session. */
  healedRef(ref: string): string | null;
};

/** The storage tunnel's error for an object the gateway could not open (a hint only; confirm with `exists`). */
export const isMissingObjectError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return message === "download_source_missing" || /[:_ ]download_source_missing$/.test(message);
};

export const EXISTS_BATCH_SIZE = 500;
const DETAILS_TTL_MS = 60_000;

/** Every slot of `media` holding a stored artwork reference. A person in both cast and crew is listed once. */
export const listHealSlots = (media: HealableMedia): ArtworkHealSlot[] => {
  const slots: ArtworkHealSlot[] = [];
  const add = (target: ArtworkHealTarget, id: string, ref: string | null | undefined, extra: Partial<ArtworkHealSlot> = {}) => {
    const key = artworkStorageKey(ref);
    // A legacy bare UUID is stored under `assets/<uuid>.txt`, not under its own name: checking it would read as missing.
    if (!key || !ref || !key.includes("/")) return;
    slots.push({ mediaId: media.id, target, id, ref, key, kind: ARTWORK_HEAL_KIND_BY_TARGET[target], ...extra });
  };
  add("mediaPoster", media.id, media.posterPath);
  add("mediaBackdrop", media.id, media.backdropPath);
  for (const season of media.seasons ?? []) add("seasonPoster", season.id, season.posterPath, { seasonNumber: season.seasonNumber });
  const seenPeople = new Set<string>();
  for (const person of [...(media.cast ?? []), ...(media.crew ?? [])]) {
    if (seenPeople.has(person.personId)) continue;
    seenPeople.add(person.personId);
    add("personProfile", person.personId, person.profilePath, { personTmdbId: person.tmdbId });
  }
  for (const episode of media.episodes ?? []) {
    add("episodeStill", episode.id, episode.stillPath, { seasonNumber: episode.seasonNumber, episodeNumber: episode.episodeNumber });
  }
  return slots;
};

/** The TMDB image path the slot was originally copied from, read from fresh metadata details. */
export const sourcePathFor = (slot: ArtworkHealSlot, details: HealSourceDetails): string | null => {
  let path: string | null | undefined;
  switch (slot.target) {
    case "mediaPoster":
      path = details.posterPath;
      break;
    case "mediaBackdrop":
      path = details.backdropPath;
      break;
    case "seasonPoster":
      path = details.seasons?.find((season) => season.seasonNumber === slot.seasonNumber)?.posterPath;
      break;
    case "episodeStill":
      path = details.episodes?.find(
        (episode) => episode.seasonNumber === slot.seasonNumber && episode.episodeNumber === slot.episodeNumber
      )?.stillPath;
      break;
    case "personProfile":
      if (slot.personTmdbId == null) return null;
      path = [...(details.cast ?? []), ...(details.crew ?? [])].find((person) => person.tmdbId === slot.personTmdbId)?.profilePath;
      break;
  }
  return typeof path === "string" && /^\/[^/]/.test(path) ? path : null;
};

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const createArtworkHealer = (deps: ArtworkHealerDeps): ArtworkHealer => {
  const log: ArtworkHealLog = deps.log ?? (() => undefined);
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const maxPerMinute = Math.max(1, deps.maxImagesPerMinute ?? 30);
  const cooldownMs = deps.cooldownMs ?? 15 * 60_000;
  const indexMaxAgeMs = deps.indexMaxAgeMs ?? 5 * 60_000;

  const healed = new Map<string, string>();
  const cooldownUntil = new Map<string, number>();
  const inflight = new Map<string, Promise<string | null>>();
  const detailsCache = new Map<string, { at: number; promise: Promise<HealSourceDetails | null> }>();
  const fetchTimes: number[] = [];
  let index: { builtAt: number; slots: Map<string, ArtworkHealSlot[]> } | null = null;
  let indexBuild: Promise<Map<string, ArtworkHealSlot[]>> | null = null;
  let sweeping: Promise<ArtworkSweepResult> | null = null;

  const coolDown = (key: string, reason: string) => {
    cooldownUntil.set(key, now() + cooldownMs);
    log("artworkHeal.cooldown", { key, reason, cooldownMs });
  };
  const cooling = (key: string) => (cooldownUntil.get(key) ?? 0) > now();

  const buildIndex = (): Promise<Map<string, ArtworkHealSlot[]>> => {
    if (indexBuild) return indexBuild;
    indexBuild = (async () => {
      const started = now();
      const slots = new Map<string, ArtworkHealSlot[]>();
      const ids = await deps.listMediaIds();
      for (const mediaId of ids) {
        const media = await deps.loadMedia(mediaId);
        if (!media) continue;
        for (const slot of listHealSlots(media)) {
          const list = slots.get(slot.key) ?? [];
          list.push(slot);
          slots.set(slot.key, list);
        }
      }
      index = { builtAt: now(), slots };
      log("artworkHeal.index", { media: ids.length, keys: slots.size, ms: now() - started });
      return slots;
    })().finally(() => {
      indexBuild = null;
    });
    return indexBuild;
  };

  const slotsForKey = async (key: string) => {
    const current = index ? index.slots : await buildIndex();
    const found = current.get(key);
    if (found || (index && now() - index.builtAt < indexMaxAgeMs)) return found ?? null;
    return (await buildIndex()).get(key) ?? null;
  };

  const takeImageBudget = async () => {
    for (;;) {
      const windowStart = now() - 60_000;
      while (fetchTimes.length > 0 && fetchTimes[0] <= windowStart) fetchTimes.shift();
      if (fetchTimes.length < maxPerMinute) {
        fetchTimes.push(now());
        return;
      }
      const waitMs = fetchTimes[0] + 60_000 - now();
      log("artworkHeal.rate_limited", { waitMs });
      await sleep(Math.max(waitMs, 1));
    }
  };

  const detailsFor = (media: HealableMedia) => {
    const cached = detailsCache.get(media.id);
    if (cached && now() - cached.at < DETAILS_TTL_MS) return cached.promise;
    const promise = deps.fetchDetails(media).catch((error) => {
      log("artworkHeal.details_failed", { mediaId: media.id, error: errorText(error) });
      return null;
    });
    detailsCache.set(media.id, { at: now(), promise });
    return promise;
  };

  /** Heals the given missing slots of one media. Resolves to key → new reference for what was swapped in. */
  const healMedia = async (mediaId: string, wanted: ArtworkHealSlot[]): Promise<Map<string, string>> => {
    const result = new Map<string, string>();
    const media = await deps.loadMedia(mediaId);
    if (!media) {
      log("artworkHeal.skip", { mediaId, reason: "media_not_in_library" });
      return result;
    }
    // Only slots still holding the broken reference: an edit or a heal from another device meanwhile wins.
    const currentRefs = new Map(listHealSlots(media).map((slot) => [`${slot.target}:${slot.id}`, slot]));
    const slots = wanted.flatMap((slot) => {
      const current = currentRefs.get(`${slot.target}:${slot.id}`);
      return current && current.ref === slot.ref ? [current] : [];
    });
    if (slots.length === 0) {
      log("artworkHeal.skip", { mediaId, reason: "reference_changed" });
      return result;
    }
    if (media.tmdbId == null) {
      for (const slot of slots) coolDown(slot.key, "no_tmdb_id");
      return result;
    }
    const details = await detailsFor(media);
    if (!details) {
      for (const slot of slots) coolDown(slot.key, "details_unavailable");
      return result;
    }
    const changes: ArtworkRefChange[] = [];
    for (const slot of slots) {
      const path = sourcePathFor(slot, details);
      if (!path) {
        coolDown(slot.key, "no_source_path");
        continue;
      }
      try {
        await takeImageBudget();
        const image = await deps.fetchImage(slot.kind, path);
        if (!image) {
          coolDown(slot.key, "image_unavailable");
          continue;
        }
        const value = await deps.store(image, slot);
        changes.push({ target: slot.target, id: slot.id, path: slot.ref, value });
        log("artworkHeal.stored", { mediaId, target: slot.target, id: slot.id, oldKey: slot.key, newRef: value, bytes: image.bytes.byteLength });
      } catch (error) {
        log("artworkHeal.store_failed", { mediaId, target: slot.target, key: slot.key, error: errorText(error) });
        coolDown(slot.key, "store_failed");
      }
    }
    if (changes.length === 0) return result;
    const applied = await deps.replaceRefs(mediaId, changes);
    log("artworkHeal.applied", { mediaId, applied, changes: changes.length });
    for (const change of changes) {
      const key = artworkStorageKey(change.path);
      if (!key) continue;
      healed.set(key, change.value);
      result.set(key, change.value);
    }
    deps.onHealed?.(mediaId, changes);
    return result;
  };

  /** Runs one heal per key at a time: a second request for a key in flight shares the first one's answer. */
  const healKeys = (mediaId: string, slots: ArtworkHealSlot[]) => {
    const run = healMedia(mediaId, slots);
    for (const slot of slots) {
      const promise = run.then((map) => map.get(slot.key) ?? null).catch(() => null);
      inflight.set(slot.key, promise);
      void promise.finally(() => {
        if (inflight.get(slot.key) === promise) inflight.delete(slot.key);
      });
    }
    return run;
  };

  const reportMissing = (ref: string): Promise<string | null> => {
    const key = artworkStorageKey(ref);
    if (!key) return Promise.resolve(null);
    const done = healed.get(key);
    if (done) return Promise.resolve(done);
    const running = inflight.get(key);
    if (running) return running;
    if (cooling(key)) return Promise.resolve(null);
    const promise = (async () => {
      let found: Record<string, boolean>;
      try {
        found = await deps.exists([key]);
      } catch (error) {
        // A failed check is never read as "missing" (STOR-PLACE-09).
        log("artworkHeal.exists_failed", { key, error: errorText(error) });
        coolDown(key, "exists_failed");
        return null;
      }
      if (found[key] !== false) {
        log("artworkHeal.not_missing", { key, exists: found[key] ?? null });
        coolDown(key, "not_missing");
        return null;
      }
      const slots = await slotsForKey(key);
      if (!slots || slots.length === 0) {
        log("artworkHeal.skip", { key, reason: "no_media_uses_key" });
        coolDown(key, "no_media_uses_key");
        return null;
      }
      const map = await healKeys(slots[0].mediaId, [slots[0]]);
      return map.get(key) ?? null;
    })().catch((error) => {
      log("artworkHeal.failed", { key, error: errorText(error) });
      coolDown(key, "failed");
      return null;
    });
    inflight.set(key, promise);
    void promise.finally(() => {
      if (inflight.get(key) === promise) inflight.delete(key);
    });
    return promise;
  };

  const sweep = (): Promise<ArtworkSweepResult> => {
    if (sweeping) return sweeping;
    sweeping = (async () => {
      const slotsByKey = await buildIndex();
      const keys = [...slotsByKey.keys()].filter((key) => !healed.has(key) && !inflight.has(key) && !cooling(key));
      const missing: string[] = [];
      for (let start = 0; start < keys.length; start += EXISTS_BATCH_SIZE) {
        const batch = keys.slice(start, start + EXISTS_BATCH_SIZE);
        let found: Record<string, boolean>;
        try {
          found = await deps.exists(batch);
        } catch (error) {
          log("artworkHeal.sweep_aborted", { checked: start, error: errorText(error) });
          return { checked: start, missing: 0, healed: 0, aborted: true };
        }
        for (const key of batch) if (found[key] === false) missing.push(key);
      }
      const byMedia = new Map<string, ArtworkHealSlot[]>();
      for (const key of missing) {
        const slot = slotsByKey.get(key)?.[0];
        if (!slot) continue;
        const list = byMedia.get(slot.mediaId) ?? [];
        list.push(slot);
        byMedia.set(slot.mediaId, list);
      }
      let healedCount = 0;
      for (const [mediaId, slots] of byMedia) {
        try {
          healedCount += (await healKeys(mediaId, slots)).size;
        } catch (error) {
          log("artworkHeal.media_failed", { mediaId, error: errorText(error) });
          for (const slot of slots) coolDown(slot.key, "failed");
        }
      }
      const result = { checked: keys.length, missing: missing.length, healed: healedCount, aborted: false };
      log("artworkHeal.sweep", result);
      return result;
    })().finally(() => {
      sweeping = null;
    });
    return sweeping;
  };

  return {
    reportMissing,
    sweep,
    healedRef: (ref) => {
      const key = artworkStorageKey(ref);
      return key ? healed.get(key) ?? null : null;
    },
  };
};
