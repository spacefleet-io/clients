import { vi } from "vitest";
import type { ParrotExportJob, ParrotExportPreview, ParrotExportStart } from "../src/shared/ipc";

/**
 * The window bridge's export calls (OFFL-FILE-01, ACCT-EXPORT-01) for suites about something else: no export ever
 * ran and none starts. `export-ui.test.tsx` drives the real flow.
 */
export const exportBridgeStub = () => ({
  previewExport: vi.fn(async (): Promise<ParrotExportPreview> => ({ songs: 0, bytes: 0 })),
  exportMusic: vi.fn(async (): Promise<ParrotExportStart> => ({ ok: false, reason: "no-folder" })),
  getExportJobs: vi.fn(async (): Promise<ParrotExportJob[]> => []),
  onExportJobs: vi.fn((_listener: (jobs: ParrotExportJob[]) => void) => () => undefined),
  cancelExport: vi.fn(async (_id: string): Promise<ParrotExportJob[]> => []),
  dismissExportJob: vi.fn(async (_id: string): Promise<ParrotExportJob[]> => []),
});
