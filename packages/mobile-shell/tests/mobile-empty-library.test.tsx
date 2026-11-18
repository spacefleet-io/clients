/**
 * @test-id MOBILE-SHELL-EMPTY-LIBRARY-001
 * @level unit
 * @why Chris 2026-11-12: "the mobile app for parrot on the [test phone] currently still shows the same empty one line text that we
 *   replaced in the desktop app, that replacement was for all clients not just desktop". Badger's phone and TV and
 *   Parrot's phone share one empty-library screen built like the computer's: the mascot standing free beside the
 *   eyebrow, "Your library" title and short line, the hand-off action, then three steps whose last icon follows the
 *   app (headphones for music). On the TV (UX-TV-18) the actions sit in the text column, the mascot and the text stand
 *   on the sky without the phone's card, the step icons are a computer, sparkles and a TV, and an `aside` (the download
 *   QR) can take the mascot's place.
 */
// @req UX-EMPTY-01[badger-mobile] @req UX-EMPTY-01[badger-tv] @req PAR-EMPTY-01[parrot] @req UX-TV-18[badger-tv]
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  Image: "Image",
  Pressable: "Pressable",
  StyleSheet: { create: <T extends Record<string, unknown>>(styles: T) => styles },
  Text: "Text",
  View: "View",
}));
vi.mock("lucide-react-native", () => ({
  Headphones: "Headphones",
  Monitor: "Monitor",
  MonitorSmartphone: "MonitorSmartphone",
  MousePointerClick: "MousePointerClick",
  Sparkles: "Sparkles",
  Tv: "Tv",
}));
vi.mock("../src/theme", () => ({
  useMobileShellTheme: () => ({
    colors: { text: "#fff", textMuted: "#aaa", accent: "#40dd8f", accentSoft: "#19322f", border: "#333333", surface: "#111111" },
    font: { family: { display: "Display" } },
    accentTextHex: "#000",
  }),
}));

import { MobileEmptyLibrary, MobileEmptyLibraryAction, type MobileEmptyLibraryProps } from "../src/components/mobile-empty-library";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const steps: MobileEmptyLibraryProps["steps"] = [
  { title: "Pick", body: "On your computer" },
  { title: "Match", body: "Details come in" },
  { title: "Play", body: "Here too" },
];

const render = (element: React.ReactElement) => {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(element);
  });
  return renderer;
};
const byTestId = (renderer: ReactTestRenderer, testID: string) =>
  renderer.root.findAll((node: { props: { testID?: string }; type: unknown }) => node.props.testID === testID && typeof node.type === "string");
const texts = (renderer: ReactTestRenderer) => renderer.root.findAll((node) => String(node.type) === "Text").map((node) => node.props.children);

describe("MobileEmptyLibrary", () => {
  it("is the computer's screen: mascot, eyebrow, title, line, the action, then three steps (music)", () => {
    const pressed: number[] = [];
    const renderer = render(
      <MobileEmptyLibrary
        kind="music"
        mascotSource={7}
        eyebrow="Your library"
        title="Add your first album"
        subtitle="Parrot finds the covers."
        actions={<MobileEmptyLibraryAction label="Get Parrot for computer" onPress={() => pressed.push(1)} />}
        steps={steps}
      />
    );
    console.info("[MOBILE-SHELL-EMPTY-LIBRARY-001] texts", JSON.stringify(texts(renderer)));
    expect(byTestId(renderer, "empty-library-mascot")[0]?.props.source).toBe(7);
    expect(texts(renderer).slice(0, 3)).toEqual(["YOUR LIBRARY", "Add your first album", "Parrot finds the covers."]);
    expect(byTestId(renderer, "empty-library-step-1")).toHaveLength(1);
    expect(byTestId(renderer, "empty-library-step-3")).toHaveLength(1);
    expect(texts(renderer)).toEqual(expect.arrayContaining(["1. Pick", "2. Match", "3. Play", "Here too"]));
    expect(renderer.root.findAll((node) => String(node.type) === "Headphones")).toHaveLength(1);
    expect(renderer.root.findAll((node) => String(node.type) === "MonitorSmartphone")).toHaveLength(0);
    expect(byTestId(renderer, "empty-library-card")[0]?.props.style).toEqual(expect.arrayContaining([expect.objectContaining({ borderWidth: 1 })]));
    const [action] = byTestId(renderer, "empty-library-action");
    expect(action?.props.accessibilityLabel).toBe("Get Parrot for computer");
    act(() => action?.props.onPress());
    expect(pressed).toHaveLength(1);
  });

  it("on the TV stands on the sky, puts the actions in the text column and lets an aside take the mascot's place (video)", () => {
    const tvProps = {
      layout: "tv" as const,
      mascotSource: 7,
      eyebrow: "Your library",
      title: "Add your first title",
      subtitle: "Badger finds the posters.",
      actions: <MobileEmptyLibraryAction label="Get Badger for computer" onPress={() => undefined} />,
      steps,
    };
    const plain = render(<MobileEmptyLibrary {...tvProps} />);
    expect(byTestId(plain, "empty-library-mascot")).toHaveLength(1);
    const iconTypes = plain.root.findAll((node) => ["Monitor", "Sparkles", "Tv", "MousePointerClick", "MonitorSmartphone"].includes(String(node.type))).map((node) => node.type);
    console.info("[MOBILE-SHELL-EMPTY-LIBRARY-001] tv step icons", JSON.stringify(iconTypes));
    expect(iconTypes).toEqual(["Monitor", "Sparkles", "Tv"]);
    const cardStyle = byTestId(plain, "empty-library-card")[0]?.props.style;
    expect(cardStyle).not.toHaveProperty("borderWidth");
    expect(cardStyle).not.toHaveProperty("backgroundColor");
    expect(byTestId(plain, "empty-library-action")).toHaveLength(1);

    const withQr = render(<MobileEmptyLibrary {...tvProps} aside={<React.Fragment>{React.createElement("View", { testID: "qr" })}</React.Fragment>} />);
    console.info("[MOBILE-SHELL-EMPTY-LIBRARY-001] tv aside", JSON.stringify({ mascot: byTestId(withQr, "empty-library-mascot").length, qr: byTestId(withQr, "qr").length }));
    expect(byTestId(withQr, "empty-library-mascot")).toHaveLength(0);
    expect(byTestId(withQr, "qr")).toHaveLength(1);
  });
});
