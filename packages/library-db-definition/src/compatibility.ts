/**
 * Cross-client library compatibility gate.
 *
 * The library DB is three independently-versioned surfaces:
 *   1. local SQLite schema (per-group `user_version`)
 *   2. op-stream format (`LibraryOp` union, versioned by `opStreamVersion`)
 *   3. remote storage/wire format (`storageFormatVersion`, see storageFormat.ts)
 *
 * A newer client can advance any of the three past what an older client
 * understands. Before the unification effort that produced this module, such
 * a skew surfaced as a cryptic `DECRYPT_FAILED` or a silently-dropped op. This
 * module is the single funnel: every open path (manifest read, op apply, group
 * migration) routes its observed version through `assertLibraryCompatible`,
 * which throws one typed `LibraryFormatTooNewError`. The UI turns that one
 * error into a clean "this library was created by a newer version" prompt.
 */

import type { LibraryDbGroup } from "./manifest";
import { READ_OP_STREAM_VERSION } from "./ops";
import { STORAGE_FORMAT_VERSION } from "./storageFormat";

/**
 * The versions *this build* supports across all three library surfaces.
 *
 * `groupSchemaVersions` is the highest `user_version` this build's per-group
 * migration registry can reach — keyed by logical group. A library group whose
 * stored `user_version` exceeds the matching entry is too new for this build.
 */
export type LibrarySupport = {
  readonly storageFormatVersion: number;
  readonly opStreamVersion: number;
  readonly groupSchemaVersions: Readonly<Record<LibraryDbGroup, number>>;
};

/** Which of the three surfaces a too-new observation came from. */
export type LibraryFormatSurface = "storage" | "op-stream" | "schema";

/**
 * A library surface was found at a version newer than this build supports.
 *
 * This is the one typed error every open path throws on a forward skew. It
 * carries enough context for the UI and logs to be specific: which surface,
 * the version observed in the library, the highest version this build
 * supports, and — for `surface: "schema"` — which group.
 */
export class LibraryFormatTooNewError extends Error {
  readonly surface: LibraryFormatSurface;
  readonly observed: number;
  readonly supported: number;
  readonly group?: string;

  constructor(detail: {
    surface: LibraryFormatSurface;
    observed: number;
    supported: number;
    group?: string;
  }) {
    const where = detail.group ? `${detail.surface}:${detail.group}` : detail.surface;
    // The message format below is a PARSED CONTRACT, not just a log line.
    // The desktop renderer never receives this typed class — the IPC boundary
    // and the runtime proxy discard the prototype — so its `parseLibraryFormatTooNew`
    // falls back to regex-matching this exact string when structured
    // `RuntimeCommandFailedError.details` is absent. Shape:
    //   LIBRARY_FORMAT_TOO_NEW: <surface[:group]> observed=<N> supported=<M>
    // Do not reorder the fields, change the `:` group separator, or rename the
    // `LIBRARY_FORMAT_TOO_NEW` token without updating the desktop matcher in
    // apps/badger/desktop/src/renderer/src/lib/libraryContext.tsx.
    super(
      `LIBRARY_FORMAT_TOO_NEW: ${where} observed=${detail.observed} supported=${detail.supported}`
    );
    this.name = "LibraryFormatTooNewError";
    this.surface = detail.surface;
    this.observed = detail.observed;
    this.supported = detail.supported;
    this.group = detail.group;
  }
}

/**
 * The set of observed library versions to check against the build's support.
 *
 * Every field is optional so each open path can assert only what it has just
 * read — the manifest reader knows `storageFormatVersion`, the op applier
 * knows `opStreamVersion`, the migration runner knows one
 * `groupSchemaVersions` entry. A caller passes whatever subset it observed.
 */
export type ObservedLibraryVersions = {
  readonly storageFormatVersion?: number;
  readonly opStreamVersion?: number;
  readonly groupSchemaVersions?: Readonly<Partial<Record<LibraryDbGroup, number>>>;
};

/**
 * Single compatibility funnel. Throws `LibraryFormatTooNewError` for the first
 * surface whose observed version exceeds what `support` declares; returns
 * normally when every observed version is at or below the supported one.
 *
 * Surfaces are checked storage → op-stream → schema so the failure a caller
 * sees is the earliest one in the open sequence (fail-fast before decrypt).
 *
 * @param observed  the versions read from the library (any subset)
 * @param support   the versions this build supports — see `LibrarySupport`
 */
export const assertLibraryCompatible = (
  observed: ObservedLibraryVersions,
  support: LibrarySupport
): void => {
  if (
    observed.storageFormatVersion !== undefined &&
    observed.storageFormatVersion > support.storageFormatVersion
  ) {
    throw new LibraryFormatTooNewError({
      surface: "storage",
      observed: observed.storageFormatVersion,
      supported: support.storageFormatVersion,
    });
  }

  if (
    observed.opStreamVersion !== undefined &&
    observed.opStreamVersion > support.opStreamVersion
  ) {
    throw new LibraryFormatTooNewError({
      surface: "op-stream",
      observed: observed.opStreamVersion,
      supported: support.opStreamVersion,
    });
  }

  if (observed.groupSchemaVersions) {
    for (const [group, observedVersion] of Object.entries(
      observed.groupSchemaVersions
    ) as Array<[LibraryDbGroup, number | undefined]>) {
      if (observedVersion === undefined) continue;
      const supportedVersion = support.groupSchemaVersions[group];
      if (supportedVersion !== undefined && observedVersion > supportedVersion) {
        throw new LibraryFormatTooNewError({
          surface: "schema",
          observed: observedVersion,
          supported: supportedVersion,
          group,
        });
      }
    }
  }
};

/**
 * The shape `currentLibrarySupport` reads a group's schema version from: any
 * array of migration records. Both `LibraryMigration` and
 * `AsyncLibraryMigration` (migrationRunner.ts) satisfy this — only `version`
 * is read — so one signature serves desktop's sync registries and mobile's
 * async registries alike.
 */
export type VersionedMigration = { readonly version: number };

/**
 * Per-group migration registries, keyed by logical group. Desktop passes its
 * five sync registries; mobile passes its four async registries. A group with
 * no registered migration is at the baseline (`user_version = 0`).
 */
export type GroupMigrationRegistries = Readonly<
  Partial<Record<LibraryDbGroup, ReadonlyArray<VersionedMigration>>>
>;

/**
 * Highest migration `version` in a registry, or `0` for an empty/absent one.
 *
 * `0` is the runner's baseline (`migrationRunner.ts`): `user_version = 0` is
 * the "post-`ensureLibrarySchema`" state, before any v1+ migration. A group
 * with no migrations supports exactly that baseline. The max is computed
 * directly (not `registry[registry.length - 1]`) so an unsorted registry
 * still yields the true highest version.
 */
const highestMigrationVersion = (
  registry: ReadonlyArray<VersionedMigration> | undefined
): number => {
  if (!registry || registry.length === 0) return 0;
  let highest = 0;
  for (const migration of registry) {
    if (migration.version > highest) highest = migration.version;
  }
  return highest;
};

/**
 * Assemble the `LibrarySupport` descriptor for *this build* — the versions it
 * supports on all three library surfaces, to feed `assertLibraryCompatible`.
 *
 * The storage and op-stream versions are build constants of this package
 * (`STORAGE_FORMAT_VERSION`, `READ_OP_STREAM_VERSION`) and are read directly:
 * the op-stream entry is the highest version this build READS (LIB-FMT-13), so
 * a switched account's version-4 stream passes the "too new" gate; what a
 * device WRITES is `writeOpStreamVersion`, never this value. The
 * per-group schema versions are NOT constants of this package: the migration
 * registries live in `@space/library-db-runtime` (desktop) and
 * `apps/badger/mobile` (mobile), both of which depend on this package — so
 * they cannot be imported back here without a dependency cycle, and desktop vs
 * mobile carry different per-group highs. The caller therefore passes its own
 * registries; this helper folds each to its highest version.
 *
 * @param registries  this build's per-group migration registries; a missing
 *                     or empty group resolves to schema version `0` (baseline)
 * @returns the `LibrarySupport` for this build, with one `groupSchemaVersions`
 *          entry per group present in `registries`
 */
export const currentLibrarySupport = (
  registries: GroupMigrationRegistries
): LibrarySupport => {
  const groupSchemaVersions: Partial<Record<LibraryDbGroup, number>> = {};
  for (const [group, registry] of Object.entries(registries) as Array<
    [LibraryDbGroup, ReadonlyArray<VersionedMigration> | undefined]
  >) {
    groupSchemaVersions[group] = highestMigrationVersion(registry);
  }
  return {
    storageFormatVersion: STORAGE_FORMAT_VERSION,
    opStreamVersion: READ_OP_STREAM_VERSION, // op-stream: read
    groupSchemaVersions: groupSchemaVersions as Readonly<
      Record<LibraryDbGroup, number>
    >,
  };
};
