import { describe, expect, it } from "vitest";
import { decodeWireBytes, encodeWireBytes } from "../src/wireBytes";

/** What the runtime route and the client do: encode, JSON over HTTP, parse, decode. */
const overTheWire = <T>(value: T): T => decodeWireBytes(JSON.parse(JSON.stringify(encodeWireBytes(value))) as T);

describe("runtime wire bytes [wire-bytes] @req RT-CMD-05", () => {
  it("a Uint8Array survives the JSON wire as a Uint8Array with the same bytes", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    const back = overTheWire(bytes);
    console.info(`[wire-bytes:top] type=${Object.prototype.toString.call(back)}`);
    expect(back).toBeInstanceOf(Uint8Array);
    expect(Array.from(back)).toEqual([0, 1, 2, 250, 255]);
    // Without the tag JSON gives `{"0":0,"1":1,…}`: an object with no `.buffer`.
    expect((JSON.parse(JSON.stringify(bytes)) as { buffer?: unknown }).buffer).toBeUndefined();
  });

  it("a Buffer, a subarray view and an ArrayBuffer arrive as plain Uint8Arrays of just their bytes", () => {
    const backing = new Uint8Array([9, 9, 1, 2, 3, 9]);
    const back = overTheWire({ buffer: Buffer.from([4, 5]), view: backing.subarray(2, 5), raw: new Uint8Array([6]).buffer });
    expect(Object.getPrototypeOf(back.buffer)).toBe(Uint8Array.prototype);
    expect(Array.from(back.buffer)).toEqual([4, 5]);
    expect(Array.from(back.view as Uint8Array)).toEqual([1, 2, 3]);
    expect(Array.from(back.raw as unknown as Uint8Array)).toEqual([6]);
  });

  it("bytes nested in arrays and objects (payload args, results) come back in place", () => {
    const back = overTheWire({ method: "importImage", args: ["id", { image: new Uint8Array([7, 8]) }], empty: new Uint8Array(0) });
    expect(back.method).toBe("importImage");
    expect(back.args[0]).toBe("id");
    expect(Array.from((back.args[1] as { image: Uint8Array }).image)).toEqual([7, 8]);
    expect(back.empty).toBeInstanceOf(Uint8Array);
    expect(back.empty.byteLength).toBe(0);
  });

  it("a value without bytes is returned as the same reference both ways (no copy of large results)", () => {
    const snapshot = { media: [{ id: "m1", tags: ["a"] }], version: 3, nothing: null };
    expect(encodeWireBytes(snapshot)).toBe(snapshot);
    expect(decodeWireBytes(snapshot)).toBe(snapshot);
  });

  it("only an object whose single key is the tag with a string is read as bytes", () => {
    const lookalikes = { a: { __sfWireBytes: "AQ==", other: 1 }, b: { __sfWireBytes: 1 } };
    expect(decodeWireBytes(lookalikes)).toBe(lookalikes);
  });
});
