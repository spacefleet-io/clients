import type { TitleDetails } from "@/api";
import { AssetArtworkError } from "./assetArtworkError";
import type { ImageKind } from "@space/metadata-client";

export type CatalogAssetOptions = {
  includeCast?: boolean;
};

/** Images fetched at the same time: each one is a ticket and an upload, and a long cast must not stampede. */
export const CATALOG_ASSET_CONCURRENCY = 3;

const mapLimit = async <T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> => {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
};

export type AttachAssetsDeps = {
  /** Encrypts and stores the artwork; throws `AssetArtworkError` when there is no image to copy. */
  upload: (kind: ImageKind, path: string) => Promise<string>;
};

export const attachAssets = async (details: TitleDetails, deps: AttachAssetsDeps, options: CatalogAssetOptions = {}) => {
  const castSource = Array.isArray(details.cast) ? details.cast : [];
  const seasonsSource = Array.isArray(details.seasons) ? details.seasons : [];

  // Artwork comes from the metadata service (META-ART-02), one ticket per image not already cached. An image that
  // cannot be fetched NOW (no ticket left, service down) keeps its catalog path instead of being recorded as "no
  // artwork": the grid resolves such a path lazily, later, and caches it. Only an image the service says does not
  // exist becomes null. Once the reserve is empty nothing more is fetched.
  let outOfTickets = false;
  const safeUpload = async (kind: ImageKind, path: string | null | undefined): Promise<string | null> => {
    if (!path) return null;
    if (outOfTickets) return path;
    try {
      return await deps.upload(kind, path);
    } catch (error) {
      if (error instanceof AssetArtworkError) {
        if (error.reason === "missing") return null;
        if (error.reason === "no_ticket") outOfTickets = true;
      }
      return path;
    }
  };

  const posterKey = await safeUpload("poster", details.posterPath);
  const backdropKey = await safeUpload("backdrop", details.backdropPath);

  const includeCast = options.includeCast ?? true;
  const cast = includeCast
    ? await mapLimit(castSource, CATALOG_ASSET_CONCURRENCY, async (member) => {
        return { ...member, profilePath: await safeUpload("profile", member.profilePath) };
      })
    : details.cast;

  const seasons = await mapLimit(seasonsSource, CATALOG_ASSET_CONCURRENCY, async (season) => {
    return { ...season, posterPath: await safeUpload("poster", season.posterPath) };
  });

  // A long series has hundreds of stills: through the metadata service each would cost a ticket, so they are left
  // as catalog paths here (`episodes` is returned unchanged) and fetched lazily, one ticket each, only when a screen
  // shows them (then cached on disk).

  return {
    ...details,
    posterPath: posterKey,
    backdropPath: backdropKey,
    cast,
    seasons,
  } satisfies TitleDetails;
};
