/**
 * Fake Azure Artifact Signing secrets for builder-config tests: a release Windows config is refused unsigned
 * (REL-INST-03, windows-signing-lib.mjs next to this file), and building the config never contacts Azure.
 */
export const SIGNED_WINDOWS_ENV: Record<string, string> = {
  AZURE_TENANT_ID: "00000000-0000-0000-0000-000000000001",
  AZURE_CLIENT_ID: "00000000-0000-0000-0000-000000000002",
  AZURE_CLIENT_SECRET: "fake-test-secret",
};
