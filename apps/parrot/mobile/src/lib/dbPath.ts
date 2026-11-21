// Where react-native-sqlite-storage keeps a database, per platform: the plugin's `location` and the file's path. Pure,
// so it is tested without the native file system module.

export type AppDirs = {
  /** RNFS.DocumentDirectoryPath: Android `<app>/files`, iOS `<app>/Documents`. */
  document: string;
  /** RNFS.LibraryDirectoryPath: iOS `<app>/Library` (unused on Android). */
  library: string;
  /** RNFS.CachesDirectoryPath: iOS `<app>/Library/Caches` (used on Apple TV only). */
  caches: string;
};

export type SqliteDb = { location: "default" | "Documents"; path: string };

/**
 * Android: `location: "default"`, the app's `databases` folder, next to `files`. iPhone: `location: "default"`,
 * `Library/LocalDatabase`, the plugin's `nosync` folder (excluded from iCloud backup). Apple TV: an app may write only to
 * `Library/Caches` on the device (the simulator allows more), so `Library/LocalDatabase` refuses the file; the patched
 * plugin keeps a `location: "Documents"` database in Caches on tvOS (patches/react-native-sqlite-storage@6.0.1.patch).
 */
export const sqliteDb = (os: string, isTV: boolean, dirs: AppDirs, name: string): SqliteDb => {
  if (os === "ios" && isTV) return { location: "Documents", path: `${dirs.caches}/${name}` };
  if (os === "ios") return { location: "default", path: `${dirs.library}/LocalDatabase/${name}` };
  return { location: "default", path: `${dirs.document.replace(/\/files$/, "")}/databases/${name}` };
};
