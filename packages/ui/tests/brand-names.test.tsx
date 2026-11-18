/**
 * @test-id UI-BRAND-NAMES-001
 * @level unit
 * @why A browser translating the page turned "Badger" into "Blaireau" (UX-I18N-13). The sites compile their JSX with
 *   `jsxImportSource: "@space/ui/brand-names"`, so every product name in an HTML element's text is wrapped in
 *   `translate="no"`; `<Trans>` output goes through `BrandNames`. The layout keeps one node per text.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { createElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { BrandNames, markBrandNamesInTree, withBrandNames } from "../src/brand-names";
import { jsx, jsxs } from "../src/brand-names/jsx-runtime";
import { jsxDEV } from "../src/brand-names/jsx-dev-runtime";

const NAME = (name: string) => `<span translate="no" class="notranslate">${name}</span>`;

// @req UX-I18N-13[web,badger-web-player,parrot-web-player]
describe("the website's JSX keeps product names out of browser translation", () => {
  it("wraps a name inside a text, and a text that is only a name", () => {
    const html = renderToStaticMarkup(
      jsxs("div", { children: [jsx("h1", { children: "Get Badger now" }), jsx("p", { children: "Parrot" })] }),
    );
    console.log("[brand] runtime", html);
    expect(html).toBe(`<div><h1><span>Get ${NAME("Badger")} now</span></h1><p>${NAME("Parrot")}</p></div>`);
  });

  it("wraps the names among other children, in the dev runtime too", () => {
    const html = renderToStaticMarkup(
      jsxDEV("p", { children: ["SpaceFleet runs ", jsx("b", { children: "Parrot" }), " and more"] }, undefined, true, undefined, undefined),
    );
    console.log("[brand] dev runtime", html);
    // The text keeps its own node (one wrapping span), so a flex or grid parent lays it out as before.
    expect(html).toBe(`<p><span>${NAME("SpaceFleet")} runs </span><b>${NAME("Parrot")}</b> and more</p>`);
  });

  it("leaves text-only elements, already-marked text and text without a name as they are", () => {
    const html = renderToStaticMarkup(
      jsxs("div", {
        children: [
          jsx("title", { children: "Badger" }),
          jsx("select", { children: jsx("option", { children: "Parrot" }) }),
          jsx("span", { translate: "no", children: "Badger" }),
          jsx("p", { children: "spacefleet.io/badger" }),
        ],
      }),
    );
    console.log("[brand] untouched", html);
    // React hoists <title> ahead of the rest; its text stays plain all the same.
    expect(html).toBe('<title>Badger</title><div><select><option>Parrot</option></select><span translate="no">Badger</span><p>spacefleet.io/badger</p></div>');
  });

  it("marks a link component's text (its <a> is built outside the runtime), not another component's", () => {
    // A router link builds its <a> with createElement, as react-router's compiled code does.
    const Link = ({ to, children }: { to: string; children?: ReactNode }) => createElement("a", { href: to }, children);
    const Label = ({ children }: { children?: ReactNode }) => createElement("i", { "aria-label": String(children) }, children);
    const html = renderToStaticMarkup(
      jsxs("div", { children: [jsx(Link, { to: "/badger", children: "Discover Badger" }), jsx(Label, { children: "Parrot" })] }),
    );
    console.log("[brand] link", html);
    expect(html).toBe(`<div><a href="/badger"><span>Discover ${NAME("Badger")}</span></a><i aria-label="Parrot">Parrot</i></div>`);
  });

  it("marks <Trans>-style trees built with createElement, through the BrandNames parent", () => {
    const tree = ["Stream with ", createElement("span", { key: "1", className: "accent" }, "Badger"), "."];
    const html = renderToStaticMarkup(createElement(BrandNames, null, tree));
    console.log("[brand] Trans parent", html);
    expect(html).toBe(`Stream with <span class="accent">${NAME("Badger")}</span>.`);
    expect(markBrandNamesInTree("no name here")).toBe("no name here");
  });

  it("returns the same string when a text holds no name", () => {
    expect(withBrandNames("Your library")).toBe("Your library");
    expect(renderToStaticMarkup(createElement("p", null, withBrandNames("Badger-Maskottchen")))).toBe(`<p><span>${NAME("Badger")}-Maskottchen</span></p>`);
  });
});
