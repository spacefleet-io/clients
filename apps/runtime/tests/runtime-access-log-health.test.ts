import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";

describe("access log of the health poll", () => {
  const originalEnv = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
    vi.restoreAllMocks();
  });

  const accessLines = async (nodeEnv: string, route: string): Promise<string[]> => {
    process.env.NODE_ENV = nodeEnv;
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
    await createApp().request(route);
    vi.restoreAllMocks();
    console.info(`[runtime-access-log-health] NODE_ENV=${nodeEnv} route=${route} lines=${JSON.stringify(lines)}`);
    return lines;
  };

  // @req RT-LOG-02
  it("is not logged in production, so an idle runtime.log stays small", async () => {
    expect(await accessLines("production", "/runtime/health")).toEqual([]);
  });

  // @req RT-LOG-02
  it("is logged in development, and other routes are logged everywhere", async () => {
    const dev = await accessLines("development", "/runtime/health");
    expect(dev.some((l) => l.includes("/runtime/health"))).toBe(true);
    const prodOther = await accessLines("production", "/");
    expect(prodOther.some((l) => l.includes("GET") && l.includes("/"))).toBe(true);
  });
});
