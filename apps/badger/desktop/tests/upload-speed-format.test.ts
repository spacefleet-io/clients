import { describe, expect, it } from "vitest";
import { formatUploadSpeedLabel } from "../src/renderer/src/lib/uploadSpeed";

describe("formatUploadSpeedLabel", () => {
  const t = (key: string, options?: Record<string, unknown>) => {
    const speed = options?.speed;
    return `${key}:${String(speed)}`;
  };

  it("returns null for missing or invalid values", () => {
    expect(formatUploadSpeedLabel(t, undefined)).toBeNull();
    expect(formatUploadSpeedLabel(t, Number.NaN)).toBeNull();
    expect(formatUploadSpeedLabel(t, 0)).toBeNull();
    expect(formatUploadSpeedLabel(t, -1)).toBeNull();
  });

  it("keeps one decimal under 10 MiB/s", () => {
    expect(formatUploadSpeedLabel(t, 9.14)).toBe("lab.queue.uploadSpeed:9.1");
  });

  it("rounds to integer at or above 10 MiB/s", () => {
    expect(formatUploadSpeedLabel(t, 10.4)).toBe("lab.queue.uploadSpeed:10");
    expect(formatUploadSpeedLabel(t, 10.6)).toBe("lab.queue.uploadSpeed:11");
  });
});
