import { describe, expect, it } from "vitest";
import * as definition from "@space/library-db-definition";
import * as shim from "../src/index";
import * as migrations from "../src/migrations";
import * as opCompaction from "../src/opCompaction";
import * as schema from "../src/schema";

describe("@space/library-db", () => {
  it("@bugfix @regression-proof re-exports the canonical definition surface from the root entrypoint", () => {
    expect(shim.compactLibraryOps).toBe(definition.compactLibraryOps);
    expect(shim.ensureLibrarySchema).toBe(definition.ensureLibrarySchema);
    expect(shim.mediaItems).toBe(definition.mediaItems);
  });

  it("keeps subpath entrypoints aligned with the canonical definition modules", () => {
    expect(migrations.ensureLibrarySchema).toBe(definition.ensureLibrarySchema);
    expect(opCompaction.compactLibraryOps).toBe(definition.compactLibraryOps);
    expect(schema.mediaFormats).toBe(definition.mediaFormats);
  });
});
