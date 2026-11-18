import { getDesktopPlatform } from "@space/desktop-platform";
import { currentDesktopBuildEnv, isDesktopDevBuild } from "../shared/devBuild";
import { applyDevBuildRuntimeDefaults } from "./runtimeSpawnEnv";

/**
 * PLAT-DESK-14: a development build gets its own runtime port and runtime data dir (see applyDevBuildRuntimeDefaults).
 * Side-effect module: it MUST be imported by the main entry before any module that reads `SF_RUNTIME_BASE_URL` at
 * load time (libraryDbIpc, libraryDbRuntimeProxy, playbackRuntimeBridge, ...), so they all see the dev build's URL.
 */
applyDevBuildRuntimeDefaults(
  process.env,
  isDesktopDevBuild(currentDesktopBuildEnv()),
  getDesktopPlatform().paths.runtimeDataDir({ ...process.env, SPACEFLEET_RUNTIME_DATA_DIR: undefined }),
);
