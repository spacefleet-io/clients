import { defineConfig } from "@hey-api/openapi-ts";

/** SDK generation (DEV-API-02). Also used by `tests/sdk.test.ts` to prove `src/generated` is current. */
export const sdkInput = "../../apps/api/openapi.json";
export const sdkPlugins = [
  "@hey-api/typescript",
  { name: "@hey-api/client-fetch", throwOnError: false },
  { name: "@hey-api/sdk", operations: { strategy: "flat" } },
] as const;

export default defineConfig({
  input: sdkInput,
  output: { path: "src/generated", clean: true },
  plugins: [...sdkPlugins],
});
