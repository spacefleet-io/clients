import { describe, expect, it } from "vitest";
import { formatActiveApiHostLabel, formatHostBadgeLabel } from "../src/components";

describe("api host settings label formatter", () => {
  console.info("[api-host-settings:suite] starting api-host label formatter tests");

  const labels = {
    apiLabel: "API",
    customBadge: "Custom",
    defaultBadge: "Default",
  };

  it("renders custom badge when custom host is configured", () => {
    const input = {
      customApiBaseUrl: "https://api.custom.test",
      defaultApiBaseUrl: "https://api.default.test",
    };
    console.info(`[api-host-settings:test] formatActiveApiHostLabel input=${JSON.stringify(input)}`);
    const result = formatActiveApiHostLabel(labels, input);
    console.info(`[api-host-settings:test] formatActiveApiHostLabel result="${result}"`);
    expect(result).toBe("API: Custom: https://api.custom.test");
  });

  it("renders default badge when custom host is not configured", () => {
    const input = {
      customApiBaseUrl: null,
      defaultApiBaseUrl: "https://api.default.test",
    };
    console.info(`[api-host-settings:test] formatActiveApiHostLabel input=${JSON.stringify(input)}`);
    const result = formatActiveApiHostLabel(labels, input);
    console.info(`[api-host-settings:test] formatActiveApiHostLabel result="${result}"`);
    expect(result).toBe("API: Default: https://api.default.test");
  });

  it("formats generic host badge labels for runtime host tooltips", () => {
    const badges = {
      customBadge: "Custom",
      defaultBadge: "Default",
    };
    const input = {
      customValue: null,
      defaultValue: "http://127.0.0.1:3020",
    };
    console.info(`[api-host-settings:test] formatHostBadgeLabel input=${JSON.stringify(input)}`);
    const result = formatHostBadgeLabel(badges, input);
    console.info(`[api-host-settings:test] formatHostBadgeLabel result="${result}"`);
    expect(result).toBe("Default: http://127.0.0.1:3020");
  });
});
