// Where react-native-sqlite-storage keeps a `location: "default"` database, per platform. Pure, so it is tested
// without the native file system module.

export type AppDirs = {
  /** RNFS.DocumentDirectoryPath: Android `<app>/files`, iOS `<app>/Documents`. */
  document: string;
  /** RNFS.LibraryDirectoryPath: iOS `<app>/Library` (unused on Android). */
  library: string;
};

/**
 * Android: the app's `databases` folder, next to `files`. iOS: `Library/LocalDatabase`, the plugin's `nosync` location
 * (excluded from iCloud backup), which `location: "default"` maps to.
 */
export const sqliteDefaultDbPath = (os: string, dirs: AppDirs, name: string): string =>
  os === "ios" ? `${dirs.library}/LocalDatabase/${name}` : `${dirs.document.replace(/\/files$/, "")}/databases/${name}`;
