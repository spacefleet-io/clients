// Where an app keeps its own files and its SQLite databases on each device, shared by Badger and Parrot (REL-FAM-05).
// The one rule both apps follow: Apple TV lets an app write only under `Library/Caches` (Documents and
// `Library/LocalDatabase` are refused on the hardware; the simulator does not enforce it), so on tvOS everything goes
// there. Pure, so it is tested without the native file system module; the caller passes the RNFS folders.

export type AppDirs = {
  /** RNFS.DocumentDirectoryPath: Android `<app>/files`, iOS `<app>/Documents`. */
  document: string;
  /** RNFS.LibraryDirectoryPath: iOS `<app>/Library` (unused on Android). */
  library: string;
  /** RNFS.CachesDirectoryPath: iOS `<app>/Library/Caches`. */
  caches: string;
};

/** react-native-sqlite-storage's `location` and the database file's path. */
export type SqliteDb = { location: "default" | "Documents"; path: string };

/**
 * Where the iPhone keeps a database, which each app chose before this was shared and keeps so no installed library
 * moves: Badger `Documents` (`location: "Documents"`), Parrot `Library/LocalDatabase` (`location: "default"`, the
 * plugin's `nosync` folder, excluded from iCloud backup).
 */
export type IphoneDbFolder = "documents" | "localDatabase";

/** The folder for the app's own files: Caches on Apple TV, Documents everywhere else. */
export const appFilesDir = (os: string, isTV: boolean, dirs: AppDirs): string =>
  os === "ios" && isTV ? dirs.caches : dirs.document;

/**
 * Android (phone and TV): `location: "default"`, the app's `databases` folder next to `files`. iPhone: the app's
 * {@link IphoneDbFolder}. Apple TV: `location: "Documents"`, which the patched plugin keeps in Caches on tvOS
 * (patches/react-native-sqlite-storage@6.0.1.patch), so the path is in Caches.
 */
export const appSqliteDb = (os: string, isTV: boolean, dirs: AppDirs, name: string, iphone: IphoneDbFolder): SqliteDb => {
  if (os === "ios" && isTV) return { location: "Documents", path: `${dirs.caches}/${name}` };
  if (os === "ios" && iphone === "documents") return { location: "Documents", path: `${dirs.document}/${name}` };
  if (os === "ios") return { location: "default", path: `${dirs.library}/LocalDatabase/${name}` };
  return { location: "default", path: `${dirs.document.replace(/\/files$/, "")}/databases/${name}` };
};
