/**
 * @test-id PARROT-MOBILE-QUERY-ANSWERED-001
 * @level unit
 * @req UX-WAIT-04[parrot]
 * @why Chris, 2026-11-18: the empty library showed before the library had loaded. A screen may only call the library
 *   empty once the album list of the library open now is read: the real hook, rendered, says `answered` only once the
 *   run for its current deps has ended, and not on the render where the deps just changed while it still holds the
 *   previous answer.
 */
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeAll, describe, expect, it } from "vitest";
import { useQuery } from "../src/state/useQuery";

const log = (step: string, detail: unknown) => console.info(`[PARROT-MOBILE-QUERY-ANSWERED-001] ${step}`, JSON.stringify(detail));

type Seen = { version: number; data: string[] | null; loading: boolean; answered: boolean };

describe("PARROT-MOBILE-QUERY-ANSWERED-001 useQuery's answered", () => {
  beforeAll(() => Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true));

  it("@req UX-WAIT-04 is false until the run for the current deps ends, also on the render where the deps change", async () => {
    const seen: Seen[] = [];
    const runs = new Map<number, PromiseWithResolvers<string[]>>();
    const Probe = ({ version }: { version: number }) => {
      const query = useQuery(() => {
        const run = Promise.withResolvers<string[]>();
        runs.set(version, run);
        return run.promise;
      }, [version]);
      seen.push({ version, data: query.data, loading: query.loading, answered: query.answered });
      return null;
    };
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(createElement(Probe, { version: 1 }));
    });
    expect(seen.every((render) => !render.answered)).toBe(true);
    await act(async () => runs.get(1)!.resolve([]));
    log("version 1 read", seen.at(-1));
    expect(seen.at(-1)).toEqual({ version: 1, data: [], loading: false, answered: true });

    const before = seen.length;
    await act(async () => tree.update(createElement(Probe, { version: 2 })));
    const whileVersion2Unread = seen.slice(before);
    log("version 2 unread", whileVersion2Unread);
    // The first render of version 2 still holds version 1's empty answer: never a verdict on version 2.
    expect(whileVersion2Unread[0]).toEqual({ version: 2, data: [], loading: false, answered: false });
    expect(whileVersion2Unread.every((render) => !render.answered)).toBe(true);

    await act(async () => runs.get(2)!.resolve(["al-meteora"]));
    log("version 2 read", seen.at(-1));
    expect(seen.at(-1)).toEqual({ version: 2, data: ["al-meteora"], loading: false, answered: true });
    await act(async () => tree.unmount());
  });
});
