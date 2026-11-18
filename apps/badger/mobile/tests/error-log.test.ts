/**
 * The phone's error log, sent only with feedback the user chose to attach it to (UX-SUP-05): each line goes through
 * the REL-LOG-06 scrubber as it is logged, so it never carries an address, a path, a file name, a title or an account.
 */
import { describe, expect, it } from "vitest";
import { readErrorLog, scopeLogger } from "@space/mobile-shell/logger";

// @req UX-SUP-02[badger-mobile]
describe("error log attached to feedback", () => {
  it("keeps warnings and errors, scrubbed of anything that names a file, a title, an address or an account", () => {
    const log = scopeLogger("player");
    log.info("start.ok", { title: "Not Kept" });
    log.warn("fetch.failed", { url: "https://api.example.com/v1/media?id=7", file: "/data/user/0/app/Dune.2024.mkv" });
    log.error("open.failed", { message: "Cannot play 'Blade Runner'", email: "someone@example.com", ip: "192.168.0.20" });
    const text = readErrorLog();
    console.info("error-log.lines", text);

    const lines = text.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\S+Z \[WARN\] \[player\] fetch\.failed /);
    expect(lines[1]).toMatch(/\[ERROR\] \[player\] open\.failed /);
    for (const secret of ["Not Kept", "example.com", "/data/user", "Dune", "Blade Runner", "someone@", "192.168"]) {
      expect(text).not.toContain(secret);
    }
  });
});
