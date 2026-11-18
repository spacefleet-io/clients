/**
 * @test-id MOBILE-CAST-003
 * @level unit
 * @why The phone serves the decrypted film on the local Wi-Fi: the address must be unguessable and one-time
 *   (INTG-CAST-01 / UX-TV-03), and text subtitles must reach the device as strict WebVTT.
 */
import { describe, expect, it } from "vitest";
import { CAST_TOKEN_BYTES, CastTokenIssuer, castPathPrefix, generateCastToken, isCastToken } from "../src/lib/cast/castToken";
import { formatVttTime, strictWebVtt } from "@space/shared/subtitleVtt";

const seeded = (start: number) => {
  let counter = start;
  return (bytes: Uint8Array) => {
    for (let i = 0; i < bytes.length; i++) bytes[i] = (counter = (counter * 1103515245 + 12345) & 0xff) | 1;
    return bytes;
  };
};

describe("cast token", () => {
  // @req UX-TV-03[badger-mobile] @req INTG-CAST-01[badger-mobile]
  it("is 32 base64url characters from 192 random bits", () => {
    const token = generateCastToken();
    expect(token).toHaveLength(32);
    expect(isCastToken(token)).toBe(true);
    expect(token).not.toMatch(/[+/=]/);
  });

  // @req UX-TV-03[badger-mobile] @req INTG-CAST-01[badger-mobile]
  it("differs on every cast", () => {
    const tokens = new Set(Array.from({ length: 200 }, () => generateCastToken()));
    expect(tokens.size).toBe(200);
  });

  // @req UX-TV-03[badger-mobile] @req INTG-CAST-01[badger-mobile]
  it("refuses a broken random source instead of minting a guessable token", () => {
    expect(() => generateCastToken((bytes) => bytes)).toThrow(/zeros/);
    expect(() => generateCastToken(() => new Uint8Array(8).fill(7))).toThrow(/8 bytes/);
  });

  // @req UX-TV-03[badger-mobile] @req INTG-CAST-01[badger-mobile]
  it("is valid until revoked, and a new cast invalidates the previous address", () => {
    const issuer = new CastTokenIssuer();
    const first = issuer.issue();
    expect(issuer.isValid(first)).toBe(true);
    expect(issuer.isValid("A".repeat(32))).toBe(false);
    const second = issuer.issue();
    expect(second).not.toBe(first);
    expect(issuer.isValid(first)).toBe(false);
    expect(issuer.isValid(second)).toBe(true);
    issuer.revoke();
    expect(issuer.isValid(second)).toBe(false);
  });

  // @req UX-TV-03[badger-mobile] @req INTG-CAST-01[badger-mobile]
  it("never repeats a token, even from a stuck source", () => {
    const issuer = new CastTokenIssuer(() => new Uint8Array(CAST_TOKEN_BYTES).fill(9));
    issuer.issue();
    expect(() => issuer.issue()).toThrow(/repeated/);
    const ok = new CastTokenIssuer(seeded(3));
    expect(ok.issue()).toHaveLength(32);
  });

  // @req UX-TV-03[badger-mobile] @req INTG-CAST-01[badger-mobile]
  it("builds the path prefix the native server answers under and rejects malformed tokens", () => {
    const token = generateCastToken();
    expect(castPathPrefix(token)).toBe(`/cast/${token}`);
    expect(() => castPathPrefix("short")).toThrow();
    expect(() => castPathPrefix(`${token.slice(0, 31)}/`)).toThrow();
  });
});

describe("WebVTT conversion", () => {
  // @req UX-TV-03[badger-mobile]
  it("formats times", () => {
    expect(formatVttTime(0)).toBe("00:00:00.000");
    expect(formatVttTime(3725.5)).toBe("01:02:05.500");
  });

  // @req UX-TV-03[badger-mobile]
  it("reads WebVTT with a BOM, CRLF and cue identifiers, keeping only the tags the device allows", () => {
    const vtt = "\uFEFFWEBVTT\r\n\r\n1\r\n00:00:01.000 --> 00:00:03.500\r\nHello <i>world</i> & <font color=\"red\">you</font> 1 < 2\r\n\r\n2\r\n01:00.5 --> 01:02.250\r\nBye\r\n";
    const out = strictWebVtt(vtt);
    expect(out.startsWith("WEBVTT\n\n")).toBe(true);
    expect(out).toContain("00:00:01.000 --> 00:00:03.500\nHello <i>world</i> &amp; you 1 &lt; 2");
    expect(out).toContain("00:01:00.500 --> 00:01:02.250\nBye");
    expect(out).not.toContain("<font");
    expect(out).not.toContain("\r");
  });

  // @req UX-TV-03[badger-mobile]
  it("cleans WebVTT for strict parsers and adds the HLS timestamp map when asked", () => {
    const vtt = "WEBVTT - title\n\nNOTE ignore me\n\nSTYLE\n::cue { color: red }\n\nintro\n00:00:01.000 --> 00:00:02.000 align:middle bogus:1\n<c.yellow>Hi</c>\n";
    const out = strictWebVtt(vtt, { hlsTimestampMap: true });
    expect(out.split("\n").slice(0, 2)).toEqual(["WEBVTT", "X-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000"]);
    expect(out).toContain("00:00:01.000 --> 00:00:02.000 align:middle\nHi");
    expect(out).not.toContain("NOTE");
    expect(out).not.toContain("STYLE");
  });

  // @req UX-TV-03[badger-mobile]
  it("drops empty and backwards cues, and gives a valid empty file for no cues", () => {
    expect(strictWebVtt("WEBVTT\n\n00:00:05.000 --> 00:00:04.000\nx\n")).toBe("WEBVTT\n");
    expect(strictWebVtt("")).toBe("WEBVTT\n");
  });

  // @req UX-TV-03[badger-mobile]
  it("reads SRT too, the format ingest stores", () => {
    const out = strictWebVtt("1\r\n00:00:01,500 --> 00:00:03,250\r\nHello\r\n");
    expect(out).toBe("WEBVTT\n\n00:00:01.500 --> 00:00:03.250\nHello\n");
  });
});
