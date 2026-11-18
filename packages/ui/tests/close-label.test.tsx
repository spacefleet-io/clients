import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CloseLabelProvider, useCloseLabel } from "../src/close-label";

// Dialog and Sheet read their screen-reader close label through this hook (UX-I18N-01).
const Probe = ({ override }: { override?: string }) => <span>{useCloseLabel(override)}</span>;

describe("CloseLabelProvider", () => {
  it("defaults to English without a provider", () => {
    expect(renderToStaticMarkup(<Probe />)).toBe("<span>Close</span>");
  });

  it("gives every dialog the app's translation", () => {
    const html = renderToStaticMarkup(
      <CloseLabelProvider label="Schließen">
        <Probe />
      </CloseLabelProvider>,
    );
    expect(html).toBe("<span>Schließen</span>");
  });

  it("lets one dialog override the provider", () => {
    const html = renderToStaticMarkup(
      <CloseLabelProvider label="Sluiten">
        <Probe override="Fermer" />
      </CloseLabelProvider>,
    );
    expect(html).toBe("<span>Fermer</span>");
  });
});
