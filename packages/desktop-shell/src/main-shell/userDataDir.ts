/**
 * The Electron userData dir of a desktop app (PLAT-DESK-14): the release build's dir, the same dir with `-dev`
 * appended for a development build (`electron-vite dev`, test builds), which talks to another server than the
 * release build and must never read its sign-in or library, and `SF_USER_DATA_PATH` over both (lanes, e2e).
 */
export const resolveUserDataDir = ({
  releaseDir,
  env,
  devBuild,
}: {
  /** Where the release build keeps its data; each app keeps the dir its existing installs use. */
  releaseDir: string;
  env: NodeJS.ProcessEnv;
  devBuild: boolean;
}): string => env.SF_USER_DATA_PATH?.trim() || (devBuild ? `${releaseDir}-dev` : releaseDir);
