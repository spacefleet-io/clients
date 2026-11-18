import { describe, expect, it, vi } from "vitest";
import {
  getDefaultBadgerMainEntryPath,
  validateBadgerMainEntryFromFile,
  validateBadgerMainEntryImports,
} from "../src/main/mainProcessOwnershipGuard";
import { handleSecondInstance } from "../src/main/secondInstanceHandler";

// Dump-on-failure: surface the validation errors / handler call records so a
// failing ownership-guard or second-instance assertion is diagnosable offline.
const dumpOwnershipGuardSnapshot = (label: string, value: unknown) => {
  try {
    console.error(`=== [main-process-ownership-guard:${label}] snapshot ===`);
    console.error(`computed:\n${JSON.stringify(value, null, 2)}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("badger main-process ownership guard", () => {
  it("accepts current main entry imports", () => {
    const entryPath = getDefaultBadgerMainEntryPath();
    console.info(`[main-process-ownership-guard:accept-current] validating main entry at ${entryPath}`);
    const errors = validateBadgerMainEntryFromFile(entryPath);
    console.info(
      `[main-process-ownership-guard:accept-current] errors.length=${errors.length} (expected 0)`,
    );
    try {
      expect(errors).toEqual([]);
    } catch (err) {
      dumpOwnershipGuardSnapshot("accept-current", { entryPath, errors });
      throw err;
    }
  });

  it("rejects non-allowlisted and forbidden local imports", () => {
    console.info(`[main-process-ownership-guard:reject-imports] validating synthetic main entry source`);
    const source = `
import { app } from "electron";
import { registerPlaybackIpc } from "./playbackIpc";
import { openDatabase } from "./db";
import { helper } from "./newBusinessLogic";
`;
    const errors = validateBadgerMainEntryImports(source);
    console.info(`[main-process-ownership-guard:reject-imports] errors=${JSON.stringify(errors)}`);
    try {
      expect(errors).toEqual([
        "forbidden import in main entry: ./db",
        "non-allowlisted local import in main entry: ./newBusinessLogic",
      ]);
    } catch (err) {
      dumpOwnershipGuardSnapshot("reject-imports", { source, errors });
      throw err;
    }
  });
});

/**
 * The pure `second-instance` handler, wired in index.ts behind `app.requestSingleInstanceLock()`. A plain second
 * launch brings the window forward; a `badger://` link launch (PLAT-WEB-05) keeps it hidden (tests/protocol-link.test.ts).
 */
describe("second-instance lock", () => {
  function makeDeps(processingState: "active" | "idle") {
    return {
      showMainWindow: vi.fn<() => void>(),
      requestQuit: vi.fn<() => void>(),
      getWindowProcessingState: vi.fn<() => "active" | "idle">().mockReturnValue(processingState),
    };
  }

  const dumpSecondInstanceSnapshot = (
    label: string,
    deps: ReturnType<typeof makeDeps>,
  ) => {
    try {
      console.error(`=== [main-process-ownership-guard:${label}] snapshot ===`);
      console.error(`showMainWindow callCount=${deps.showMainWindow.mock.calls.length}`);
      console.error(`requestQuit callCount=${deps.requestQuit.mock.calls.length}`);
      console.error(
        `getWindowProcessingState callCount=${deps.getWindowProcessingState.mock.calls.length}`,
      );
    } catch (err) {
      console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
    }
  };

  it("active processing: showMainWindow called once, requestQuit not called", () => {
    console.info(`[main-process-ownership-guard:second-instance-active] processingState=active`);
    const deps = makeDeps("active");
    handleSecondInstance(deps);
    console.info(
      `[main-process-ownership-guard:second-instance-active] showMainWindow=${deps.showMainWindow.mock.calls.length} requestQuit=${deps.requestQuit.mock.calls.length}`,
    );
    try {
      expect(deps.showMainWindow).toHaveBeenCalledTimes(1);
      expect(deps.requestQuit).not.toHaveBeenCalled();
    } catch (err) {
      dumpSecondInstanceSnapshot("second-instance-active", deps);
      throw err;
    }
  });

  it("idle processing: showMainWindow called once, requestQuit not called", () => {
    console.info(`[main-process-ownership-guard:second-instance-idle] processingState=idle`);
    const deps = makeDeps("idle");
    handleSecondInstance(deps);
    console.info(
      `[main-process-ownership-guard:second-instance-idle] showMainWindow=${deps.showMainWindow.mock.calls.length} requestQuit=${deps.requestQuit.mock.calls.length}`,
    );
    try {
      expect(deps.showMainWindow).toHaveBeenCalledTimes(1);
      expect(deps.requestQuit).not.toHaveBeenCalled();
    } catch (err) {
      dumpSecondInstanceSnapshot("second-instance-idle", deps);
      throw err;
    }
  });

  it("active processing: getWindowProcessingState not required for the focus decision (today's behavior)", () => {
    console.info(`[main-process-ownership-guard:second-instance-no-gate] processingState=active, asserting unconditional focus`);
    // The handler must work even if getWindowProcessingState is never invoked.
    // This pins today's behavior: processing state does NOT gate the showMainWindow call.
    const deps = makeDeps("active");
    handleSecondInstance(deps);
    console.info(
      `[main-process-ownership-guard:second-instance-no-gate] showMainWindow=${deps.showMainWindow.mock.calls.length} requestQuit=${deps.requestQuit.mock.calls.length} getWindowProcessingState=${deps.getWindowProcessingState.mock.calls.length}`,
    );
    try {
      // showMainWindow fires unconditionally — processing state is not consulted
      expect(deps.showMainWindow).toHaveBeenCalledTimes(1);
      // requestQuit never fires regardless of processing state
      expect(deps.requestQuit).not.toHaveBeenCalled();
    } catch (err) {
      dumpSecondInstanceSnapshot("second-instance-no-gate", deps);
      throw err;
    }
  });
});
