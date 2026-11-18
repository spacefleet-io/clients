/**
 * @test-id DETAILS-HERO-BLANK-001
 * @level component
 * @why On Badger iPhone 0.1.2 (Release, iOS 26.4 simulator, 2026-11-18) the title page hero (UX-PHONE-04) was blank on
 *   every title, the picture loaded and valid. A probe build of that binary drew a masked Rect and an unmasked SvgImage,
 *   but nothing of a masked SvgImage while its `<Mask>` kept the default `maskUnits="objectBoundingBox"`; the same image
 *   under a `maskUnits="userSpaceOnUse"` mask drew with its fade. react-native-svg on iOS sizes an objectBoundingBox
 *   mask from the image's own bounds. The TV backdrop (UX-TV-06) masks its picture the same way. Each mask that fades
 *   an image now spans the whole Svg in user space.
 *
 * The real `DetailsHeroArt` renders with react-test-renderer, react-native-svg as named host elements.
 *
 * @bugfix @regression-proof
 * @req UX-PHONE-04[badger-mobile]
 */
import { createElement } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it } from "vitest";
import { DetailsHeroArt } from "../src/components/DetailsHeroArt";

const render = async (uri: string | null): Promise<ReactTestRenderer> => {
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(createElement(DetailsHeroArt, { uri }));
  });
  return renderer!;
};

const maskOf = (renderer: ReactTestRenderer, masked: ReactTestInstance): ReactTestInstance => {
  const id = /^url\(#(.+)\)$/.exec(String(masked.props.mask))?.[1];
  const masks = renderer.root.findAll((node) => String(node.type) === "Mask" && node.props.id === id);
  expect(masks).toHaveLength(1);
  return masks[0];
};

describe("title page hero mask (DETAILS-HERO-BLANK-001)", () => {
  it("@req UX-PHONE-04 fades the picture under a mask spanning the whole hero in user space", async () => {
    const renderer = await render("file:///cache/assets/poster.jpg");
    const posters = renderer.root.findAll((node) => node.props.testID === "details-poster" && typeof node.type === "string");
    expect(posters).toHaveLength(1);
    expect(posters[0].props.href).toEqual({ uri: "file:///cache/assets/poster.jpg" });
    const mask = maskOf(renderer, posters[0]);
    console.info("[DETAILS-HERO-BLANK-001] hero mask", JSON.stringify({ id: mask.props.id, maskUnits: mask.props.maskUnits }));
    expect(mask.props).toMatchObject({ x: "0", y: "0", width: "100%", height: "100%", maskUnits: "userSpaceOnUse" });
    // The fade itself is unchanged: one Rect over the whole mask, filled with the hero gradient.
    const rects = mask.findAll((node) => String(node.type) === "Rect");
    expect(rects).toHaveLength(1);
    expect(rects[0].props.fill).toBe("url(#heroFade)");
  });

  it("fades the plain surface the same way while the title has no picture", async () => {
    const renderer = await render(null);
    expect(renderer.root.findAll((node) => node.props.testID === "details-poster")).toHaveLength(0);
    const surfaces = renderer.root.findAll((node) => String(node.type) === "Rect" && node.props.mask !== undefined);
    expect(surfaces).toHaveLength(1);
    expect(maskOf(renderer, surfaces[0]).props.maskUnits).toBe("userSpaceOnUse");
  });
});
