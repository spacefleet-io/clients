import { describe, expect, it } from "vitest";
import {
  evaluateEmailDomainAgainstSets,
  extractEmailDomain,
  parseDomainSet,
  splitDomainList,
} from "../src/emailDomainPolicy";

// Dump-on-failure for a precedence/evaluation regression: surface the email
// under test, the configured allow/deny/upstream sets and the full evaluation
// result so a CI failure pins which set won (or failed to win) without a local
// repro. Wrapped in try/catch so a dump failure can't mask the assertion.
const dumpPolicySnapshot = (
  label: string,
  email: string,
  sets: { allowSet: Set<string>; denySet: Set<string>; upstreamSet: Set<string> },
  result: unknown,
) => {
  try {
    console.error(`=== [email-domain-policy:${label}] evaluation snapshot ===`);
    console.error(`email=${JSON.stringify(email)} extractedDomain=${JSON.stringify(extractEmailDomain(email))}`);
    console.error(`allowSet=${JSON.stringify([...sets.allowSet])}`);
    console.error(`denySet=${JSON.stringify([...sets.denySet])}`);
    console.error(`upstreamSet=${JSON.stringify([...sets.upstreamSet])}`);
    console.error(`result=${JSON.stringify(result)}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("shared email domain policy", () => {
  it("normalizes and extracts email domain", () => {
    console.info(`[email-domain-policy:extract] extracting domain from "User@Mailinator.Com"`);
    const actual = extractEmailDomain("User@Mailinator.Com");
    if (actual !== "mailinator.com") {
      console.error(`=== [email-domain-policy:extract] mismatch ===`);
      console.error(`input="User@Mailinator.Com" expected="mailinator.com" actual=${JSON.stringify(actual)}`);
    }
    expect(actual).toBe("mailinator.com");
  });

  it("splits domain lists", () => {
    console.info(`[email-domain-policy:parse-lists] splitting domain list text`);
    const split = splitDomainList("a.com, b.com;\nc.com");
    try {
      expect(split).toEqual(["a.com", "b.com", "c.com"]);
    } catch (err) {
      console.error(`=== [email-domain-policy:parse-lists] splitDomainList mismatch ===`);
      console.error(`actual=${JSON.stringify(split)}`);
      throw err;
    }
  });

  it("applies allow > deny > upstream precedence with subdomain matching", () => {
    console.info(`[email-domain-policy:precedence] building allow/deny/upstream sets`);
    const upstreamSet = parseDomainSet(["mailinator.com"]);
    const denySet = parseDomainSet(["junk.local"]);
    const allowSet = parseDomainSet(["mailinator.com"]);

    console.info(`[email-domain-policy:precedence] case allow-wins: user@mailinator.com (allow+upstream both match)`);
    const allowResult = evaluateEmailDomainAgainstSets("user@mailinator.com", {
      allowSet,
      denySet,
      upstreamSet,
    });
    try {
      expect(allowResult.allowed).toBe(true);
    } catch (err) {
      dumpPolicySnapshot("precedence-allow-wins", "user@mailinator.com", { allowSet, denySet, upstreamSet }, allowResult);
      throw err;
    }

    console.info(`[email-domain-policy:precedence] case deny-subdomain: user@x.junk.local (subdomain of deny)`);
    const denySets = { allowSet: new Set<string>(), denySet, upstreamSet };
    const denyResult = evaluateEmailDomainAgainstSets("user@x.junk.local", denySets);
    try {
      expect(denyResult.source).toBe("local_deny");
    } catch (err) {
      dumpPolicySnapshot("precedence-deny-subdomain", "user@x.junk.local", denySets, denyResult);
      throw err;
    }

    console.info(`[email-domain-policy:precedence] case upstream-subdomain: user@x.mailinator.com (subdomain of upstream)`);
    const upstreamSets = { allowSet: new Set<string>(), denySet: new Set<string>(), upstreamSet };
    const upstreamResult = evaluateEmailDomainAgainstSets("user@x.mailinator.com", upstreamSets);
    try {
      expect(upstreamResult.source).toBe("upstream");
    } catch (err) {
      dumpPolicySnapshot("precedence-upstream-subdomain", "user@x.mailinator.com", upstreamSets, upstreamResult);
      throw err;
    }
  });
});

