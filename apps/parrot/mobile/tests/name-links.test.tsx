/**
 * @test-id PARROT-MOBILE-NAME-LINKS-001
 * @level unit
 * @req PAR-NAV-05[parrot]
 * @why Chris, 2026-11-15 (issue #2508): an artist's or album's name opens that page wherever it is shown. On the phone a
 *   song's line under its title names its artist and album; each name is its own tappable text that opens the artist's
 *   or the album's page instead of playing the song. The row is called as a function against a mocked React Native.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  ActivityIndicator: "ActivityIndicator",
  Pressable: "Pressable",
  StyleSheet: { create: <T extends Record<string, unknown>>(styles: T) => styles, hairlineWidth: 1 },
  Text: "Text",
  View: "View",
}));
vi.mock("lucide-react-native", () => ({ Ellipsis: "Icon:Ellipsis" }));
vi.mock("@space/mobile-shell/theme", () => ({ UNAVAILABLE_LOOK: {} }));
vi.mock("../src/theme", () => ({ colors: { accent: "#0f0", textMuted: "#888" }, spacing: { sm: 4, md: 8 } }));
vi.mock("../src/screens/equalizer", () => ({ ParrotEqualizer: "ParrotEqualizer" }));

import { SongListRow, songRowNames } from "../src/screens/SongListRow";

const SUITE = "[PARROT-MOBILE-NAME-LINKS-001]";
type Element = { type: unknown; props: Record<string, unknown> & { children?: unknown } };
const all = (node: unknown, out: Element[] = []): Element[] => {
  if (Array.isArray(node)) node.forEach((child) => all(child, out));
  else if (node && typeof node === "object" && "props" in node) {
    out.push(node as Element);
    all((node as Element).props.children, out);
  }
  return out;
};

const NOOK = { artistName: "Linnet Park", artistId: "art-lp", albumTitle: "Meltway", albumId: "alb-met" };

describe("the phone's song rows: artist and album names open their pages (PAR-NAV-05)", () => {
  it("names the artist and the album, each opening its page", () => {
    const sent: unknown[] = [];
    const names = songRowNames(NOOK, { navigate: ((...args: unknown[]) => void sent.push(args)) as never });
    console.info(SUITE, "names", JSON.stringify(names.map(({ text, testID }) => ({ text, testID }))));
    expect(names.map((name) => [name.text, name.testID])).toEqual([
      ["Linnet Park", "song-artist-link"],
      ["Meltway", "song-album-link"],
    ]);
    for (const name of names) name.onPress!();
    console.info(SUITE, "navigated", JSON.stringify(sent));
    expect(sent).toEqual([
      ["Artist", { artistId: "art-lp", name: "Linnet Park" }],
      ["Album", { albumId: "alb-met", title: "Meltway", artistName: "Linnet Park" }],
    ]);
  });

  it("an artist without an id is plain text, the album still opens", () => {
    const names = songRowNames({ ...NOOK, artistId: null }, { navigate: () => undefined });
    expect(names[0]!.onPress).toBeUndefined();
    expect(names[1]!.onPress).toBeTypeOf("function");
  });

  it("the row draws each name as its own pressable text, apart from the row that plays the song", () => {
    const played: string[] = [];
    const opened: string[] = [];
    const tree = SongListRow({
      lead: 13,
      title: "Nook",
      names: [
        { text: "Linnet Park", testID: "song-artist-link", onPress: () => opened.push("artist") },
        { text: "Meltway", testID: "song-album-link", onPress: () => opened.push("album") },
      ],
      durationMs: 185_000,
      playing: null,
      starting: false,
      disabled: false,
      accessibilityLabel: "Nook",
      onPress: () => played.push("Nook"),
    }) as unknown as Element;
    const links = all(tree).filter((el) => typeof el.props.testID === "string" && String(el.props.testID).endsWith("-link"));
    console.info(SUITE, "links", JSON.stringify(links.map((el) => [el.type, el.props.testID, el.props.children, el.props.accessibilityRole])));
    expect(links.map((el) => [el.type, el.props.testID, el.props.children])).toEqual([
      ["Text", "song-artist-link", "Linnet Park"],
      ["Text", "song-album-link", "Meltway"],
    ]);
    for (const link of links) (link.props.onPress as () => void)();
    expect(opened).toEqual(["artist", "album"]);
    expect(played).toEqual([]);
  });
});
