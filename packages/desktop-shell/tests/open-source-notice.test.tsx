/**
 * @test-id DESKTOP-SHELL-OSS-001
 * @level unit
 * @why Chris 2026-11-12 (chat): "the link should also go into the app's opensource section". Each computer app and web
 *   player opens its credits place with "<App> is open source, under the GPL-3.0 licence." and a link to the public
 *   client repository, the one address the website uses too.
 */
// @req UX-SET-03[badger-desktop] @req UX-SET-03[badger-web-player] @req UX-SET-03[parrot] @req UX-SET-03[parrot-web-player]
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PUBLIC_CLIENT_REPO_URL } from "@space/shared/publicClientRepo";
import { OpenSourceNotice } from "../src/components/open-source-notice";

describe("OpenSourceNotice", () => {
  it.each([
    ["en", "badger", "Badger is open source, under the GPL-3.0 licence.", "View the source code"],
    ["en", "parrot", "Parrot is open source, under the GPL-3.0 licence.", "View the source code"],
    ["fr", "parrot", "Parrot est un logiciel libre, sous licence GPL-3.0.", "Voir le code source"],
    ["de", "badger", "Badger ist Open Source, unter der Lizenz GPL-3.0.", "Quellcode ansehen"],
    ["nl", "badger", "Badger is open source, onder de GPL-3.0-licentie.", "Bekijk de broncode"],
    ["es", "parrot", "Parrot es de código abierto, bajo la licencia GPL-3.0.", "Ver el código fuente"],
  ] as const)("@req UX-SET-03 shows the GPL line and the source link in %s (%s)", (language, product, notice, link) => {
    const html = renderToStaticMarkup(<OpenSourceNotice language={language} product={product} />);
    console.info(`[DESKTOP-SHELL-OSS-001] ${language}/${product}: ${html}`);
    expect(html).toContain(`<span>${notice}</span>`);
    expect(html).toContain(`href="${PUBLIC_CLIENT_REPO_URL}"`);
    expect(html).toContain(`>${link}</a>`);
    // UX-I18N-10: the language pickers' flag artwork is credited under the link.
    expect(html).toMatch(/data-testid="open-source-flags">[^<]*Noto[ -]Emoji[^<]*Apache[^<]*2\.0/);
    // UX-SET-03: the bundled Inter and Space Grotesk fonts are credited under their OFL licence.
    expect(html).toMatch(/data-testid="open-source-fonts">[^<]*Inter[^<]*Space Grotesk[^<]*SIL Open Font License 1\.1/);
    // `_blank` reaches the Electron window-open handler, which opens https pages in the system browser.
    expect(html).toContain('target="_blank"');
    expect(PUBLIC_CLIENT_REPO_URL).toBe("https://github.com/spacefleet-io/clients");
  });
});
