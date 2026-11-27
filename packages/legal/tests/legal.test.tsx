import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import {
  LEGAL_CONTENT,
  LEGAL_LANGUAGES,
  LEGAL_FOOTER_SLUGS,
  LEGAL_SLUGS,
  legalContentFor,
  legalItemText,
  parseLegalInline,
  type LegalContent,
  type LegalLanguage,
  type LegalSlug,
} from "../src/index";
import { CheckoutConsentBoxes, LegalLinks, LegalPage, NO_CHECKOUT_CONSENT, SignupTermsNotice } from "../src/components";
import { PUBLISHER_POSTAL_ADDRESS } from "../src/publisher";
import { accountDeletionPath, withAccountDeletionLabels } from "@space/shared/accountDeletionLabels";

const repo = resolve(__dirname, "../../..");
const readRepo = (path: string) => readFileSync(resolve(repo, path), "utf8");
const readJson = (path: string) => JSON.parse(readRepo(path)) as Record<string, any>;

const pageText = (content: LegalContent, slug: LegalSlug) => {
  const page = content.pages[slug];
  return [
    page.title,
    page.intro,
    ...page.sections.flatMap((s) => [
      s.heading,
      ...s.blocks.map((b) => (typeof b === "string" ? b : b.items.map(legalItemText).join("\n"))),
    ]),
  ].join("\n");
};

const shape = (content: LegalContent) =>
  LEGAL_SLUGS.map((slug) => ({
    slug,
    sections: content.pages[slug].sections.map((s) =>
      s.blocks.map((b) => (typeof b === "string" ? "p" : `ul:${b.items.length}`)),
    ),
  }));
const pageLinks = (text: string) =>
  parseLegalInline(text)
    .filter((part) => part.kind === "page")
    .map((part) => (part.kind === "page" ? part.slug : ""));

describe("legal pages: one source for the website", () => {
  // @req WEB-LEGAL-01[web]
  it("has the legal and security pages in English and French with the same structure and the same cross-links", () => {
    for (const lang of LEGAL_LANGUAGES) {
      expect(Object.keys(LEGAL_CONTENT[lang].pages).sort()).toEqual([...LEGAL_SLUGS].sort());
      for (const slug of LEGAL_SLUGS) expect(LEGAL_CONTENT[lang].nav[slug].length).toBeGreaterThan(3);
    }
    expect(shape(LEGAL_CONTENT.fr)).toEqual(shape(LEGAL_CONTENT.en));
    for (const slug of LEGAL_SLUGS) {
      expect(pageLinks(pageText(LEGAL_CONTENT.fr, slug))).toEqual(pageLinks(pageText(LEGAL_CONTENT.en, slug)));
    }
  });

  // @req WEB-LEGAL-01[web]
  it("renders every page in both languages, with its cross-links resolved and the app footer", () => {
    for (const lang of LEGAL_LANGUAGES) {
      for (const slug of LEGAL_SLUGS) {
        const html = renderToStaticMarkup(
          <MemoryRouter initialEntries={[`/${lang}/${slug}`]}>
            <Routes>
              <Route path="/:lang/*" element={<LegalPage slug={slug} footer={<footer>FOOTER</footer>} />} />
            </Routes>
          </MemoryRouter>,
        );
        expect(html).toContain(`data-testid="legal-${slug}"`);
        expect(html).toContain(LEGAL_CONTENT[lang].pages[slug].title.replace(/'/g, "&#x27;"));
        const links = pageLinks(pageText(LEGAL_CONTENT[lang], slug));
        for (const other of links) expect(html).toContain(`href="/${lang}/${other}"`);
        expect(html).toContain("FOOTER");
        expect(html).not.toContain("page:");
      }
    }
  });

  // @req WEB-LEGAL-01[web]
  it("footer links point at the legal pages and the security policy in the current language", () => {
    const fr = renderToStaticMarkup(<LegalLinks language="fr-FR" />);
    const en = renderToStaticMarkup(<LegalLinks language="en" />);
    expect(LEGAL_FOOTER_SLUGS).toEqual(["legal-notice", "privacy", "terms", "account-deletion", "security"]);
    for (const slug of LEGAL_FOOTER_SLUGS) {
      expect(fr).toContain(`href="/fr/${slug}"`);
      expect(en).toContain(`href="/en/${slug}"`);
    }
    expect(renderToStaticMarkup(<LegalLinks language={undefined} />)).toContain('href="/en/privacy"');
  });
});

describe("legal notice", () => {
  // @req WEB-LEGAL-02[web]
  it("names the publisher, its registration, contact, director and host", () => {
    for (const lang of LEGAL_LANGUAGES) {
      const text = pageText(LEGAL_CONTENT[lang], "legal-notice");
      for (const fact of [
        "Chris-Alexandre Pena",
        "EI (entrepreneur individuel)",
        "SpaceFleet",
        "822 965 737",
        "FR67822965737",
        "contact@spacefleet.io",
        "https://spacefleet.io",
        "Hetzner Online GmbH, Industriestr. 25, 91710 Gunzenhausen",
        "+49 9831 505-0",
        "Cloudflare, Inc.",
      ]) {
        expect(text).toContain(fact);
      }
      const director = { en: "Director of publication", fr: "Directeur de la publication", nl: "Verantwoordelijke voor de publicatie", de: "Verantwortlich für den Inhalt", es: "Director de la publicación" };
      expect(text).toContain(director[lang]);
    }
  });

  // @req WEB-LEGAL-02[web] @req WEB-LEGAL-03[web] @req WEB-LEGAL-05[web]
  it("gives the domiciliation address and never the EI's home address in the legal notice, the privacy policy and the terms", () => {
    // Parts of the home address; its street name itself is kept out of this public package.
    const homeParts = ["54 rue", "31000", "Toulouse"];
    expect(PUBLISHER_POSTAL_ADDRESS).toBe("8 bis rue Abel, 75012 Paris, France");
    for (const lang of LEGAL_LANGUAGES) {
      for (const slug of ["legal-notice", "privacy", "terms"] as const) {
        const text = pageText(LEGAL_CONTENT[lang], slug);
        const leaks = homeParts.filter((part) => text.includes(part));
        console.info(`[legal:address] ${lang}/${slug}: domiciliation shown: ${text.includes(PUBLISHER_POSTAL_ADDRESS!)}, home address parts shown: ${JSON.stringify(leaks)}`);
        expect(text).toContain(PUBLISHER_POSTAL_ADDRESS);
        expect(leaks).toEqual([]);
        expect(text).not.toMatch(/\[\[postal:|\{\{publisherPostalAddress\}\}/);
      }
    }
    const notice = { en: "Address: ", fr: "Adresse : ", de: "Anschrift: ", es: "Dirección: ", nl: "Adres: " };
    for (const lang of LEGAL_LANGUAGES) {
      expect(pageText(LEGAL_CONTENT[lang], "legal-notice")).toContain(`${notice[lang]}${PUBLISHER_POSTAL_ADDRESS}`);
      expect(pageText(LEGAL_CONTENT[lang], "privacy")).toContain(`SIREN 822 965 737, ${PUBLISHER_POSTAL_ADDRESS})`);
      // Without an address, the notice's address item goes away rather than leaving an empty line.
      const block = legalContentFor(lang, null).pages["legal-notice"].sections[0].blocks[0];
      expect(typeof block === "string" ? 0 : block.items.length).toBe(5);
      expect(pageText(legalContentFor(lang, null), "privacy")).toContain("(SIREN 822 965 737)");
    }
  });

});

describe("privacy policy", () => {
  // @req WEB-LEGAL-03[web] @req WEB-LEGAL-09[web]
  it("states what the servers see despite encryption, the providers, retention and rights, and never claims anonymity", () => {
    const en = pageText(LEGAL_CONTENT.en, "privacy");
    for (const fact of [
      "email address",
      "how much data you store",
      "when uploads happen",
      "devices signed in",
      "titles your apps look up",
      "IP address",
      "We show no ads",
      "no cookies",
      "Hetzner Online GmbH",
      "Cloudflare, Inc.",
      "Stancer (Iliad 78 SAS",
      "Firebase Cloud Messaging",
      "Apple Push Notification service",
      "Server logs: 30 days",
      "more than 30 days old, except the most recent copy",
      "10 years after the end of the financial year",
      "until you unsubscribe",
      "CNIL",
      "privacy@spacefleet.io",
    ]) {
      expect(en).toContain(fact);
    }
    expect(pageText(LEGAL_CONTENT.fr, "privacy")).toContain("CNIL");
    // UX-SUP-01: privacy and data-subject requests go to privacy@, never to contact@ (press and partners).
    for (const lang of LEGAL_LANGUAGES) {
      const privacy = pageText(LEGAL_CONTENT[lang], "privacy");
      expect(privacy, lang).toContain("privacy@spacefleet.io");
      expect(privacy, lang).not.toContain("contact@spacefleet.io");
    }
    expect(pageText(LEGAL_CONTENT.en, "privacy")).toContain("18 or over, or the age of majority where they live if that is higher");
    for (const lang of LEGAL_LANGUAGES) {
      const content = LEGAL_CONTENT[lang];
      const text = [JSON.stringify(content.nav), content.updated, ...LEGAL_SLUGS.map((slug) => pageText(content, slug))]
        .join("\n")
        .toLowerCase();
      expect(text).not.toMatch(/anonym/);
      expect(text).not.toMatch(/zero.knowledge|zéro connaissance|learn nothing|ne sait rien/);
    }
  });

  // @req WEB-LEGAL-03[web] @req PRIV-SRV-02[api]
  it("says the server logs are counted per kind of request, naming no one, and the counts go with the logs after 30 days", () => {
    const facts: Record<LegalLanguage, string[]> = {
      en: ["how many requests of each kind", "these counts name no one and are deleted with the logs after 30 days"],
      fr: ["combien de requêtes de chaque type", "ces décomptes ne désignent personne et sont supprimés avec les journaux au bout de 30 jours"],
      de: ["wie viele Anfragen jeder Art", "diese Zählungen nennen niemanden und werden nach 30 Tagen mit den Protokollen gelöscht"],
      es: ["cuántas solicitudes de cada tipo", "estos recuentos no identifican a nadie y se eliminan con los registros a los 30 días"],
      nl: ["hoeveel verzoeken van elk soort", "deze tellingen noemen niemand en worden na 30 dagen met de logbestanden verwijderd"],
    };
    for (const lang of LEGAL_LANGUAGES) {
      const privacy = pageText(LEGAL_CONTENT[lang], "privacy");
      for (const fact of facts[lang]) expect(privacy, lang).toContain(fact);
      console.info(`[legal:request-counts] ${lang}: ${facts[lang].length} fact(s) present`);
      expect(LEGAL_CONTENT[lang].updated).toMatch(/26/);
    }
  });

  // @req PRIV-SRV-02[api] @req OPS-BIZ-20[api]
  it("names the daily app hello and the daily usage counts: no id, no address, totals only, under 3 never shown", () => {
    const facts: Record<LegalLanguage, string[]> = {
      en: ["once a day, each SpaceBadger and SpaceParrot app tells our servers that it ran", "no device or installation identifier", "we keep no internet address with it", "syncs, stream starts, uploads and sign-ins", "totals below 3 are never shown"],
      fr: ["une fois par jour, chaque application SpaceBadger et SpaceParrot indique à nos serveurs qu'elle a fonctionné", "ni identifiant d'appareil ou d'installation", "nous ne gardons aucune adresse internet avec", "un total inférieur à 3 n'est jamais affiché"],
      de: ["Einmal am Tag meldet jede SpaceBadger- und SpaceParrot-App", "keine Geräte- oder Installationskennung", "wir speichern dazu keine Internetadresse", "Summen unter 3 werden nie angezeigt"],
      es: ["una vez al día, cada app SpaceBadger y SpaceParrot indica", "ningún identificador de dispositivo o de instalación", "no guardamos ninguna dirección de internet", "los totales inferiores a 3 nunca se muestran"],
      nl: ["één keer per dag laat elke SpaceBadger- en SpaceParrot-app", "geen apparaat- of installatie-ID", "we bewaren er geen internetadres bij", "totalen onder 3 worden nooit getoond"],
    };
    for (const lang of LEGAL_LANGUAGES) {
      const privacy = pageText(LEGAL_CONTENT[lang], "privacy");
      for (const fact of facts[lang]) expect(privacy, lang).toContain(fact);
      console.info(`[legal:usage-counts] ${lang}: ${facts[lang].length} fact(s) present`);
    }
  });

  // @req WEB-LEGAL-03[web] @req WEB-LEGAL-09[web]
  // @req REL-LOG-06[badger-desktop,badger-mobile,badger-tv]
  it("names opt-in error reports: what one holds and never holds, our own Bugsink server, and the 90-day limit", () => {
    const facts: Record<"en" | "fr", string[]> = {
      en: [
        "Error reports (off until you turn them on, in the app's settings or during its setup steps)",
        "Bugsink) that we run ourselves",
        "the stack trace",
        "the app version",
        "the name and version of the operating system",
        "It never contains a file name, a title, a file path or your account details",
        "Legal basis: your consent (art. 6(1)(a)), which you can withdraw at any time by turning error reports off",
        "reports.spacefleet.io",
        "hosted by Hetzner in Falkenstein (Germany)",
        "Error reports, if you turn them on, go only to our own server",
        "Error reports: 90 days after they arrive, then deleted.",
      ],
      fr: [
        "Rapports d'erreur (désactivés tant que vous ne les activez pas, dans les réglages de l'application ou lors de sa configuration)",
        "Bugsink) que nous exploitons nous-mêmes",
        "la pile d'appels",
        "la version de l'application",
        "le nom et la version du système d'exploitation",
        "Il ne contient jamais de nom de fichier, de titre, de chemin de fichier ni les informations de votre compte",
        "Base légale : votre consentement (art. 6.1.a), que vous pouvez retirer à tout moment en désactivant les rapports d'erreur",
        "reports.spacefleet.io",
        "hébergé par Hetzner à Falkenstein (Allemagne)",
        "Les rapports d'erreur, si vous les activez, ne partent que vers notre propre serveur",
        "Rapports d'erreur : 90 jours après leur réception, puis supprimés.",
      ],
    };
    for (const lang of ["en", "fr"] as const) {
      const text = pageText(LEGAL_CONTENT[lang], "privacy");
      const missing = facts[lang].filter((fact) => !text.includes(fact));
      console.info(`[legal:error-reports] ${lang}: ${facts[lang].length - missing.length}/${facts[lang].length} facts present`);
      if (missing.length) console.info(`[legal:error-reports] ${lang} missing:\n  ${missing.join("\n  ")}\n--- page text ---\n${text}`);
      expect(missing, `${lang} privacy policy is missing error-report facts`).toEqual([]);
      // Logs and reports run in Falkenstein (REL-LOG-03); the policy once said "in France".
      expect(text).not.toMatch(/operated by the publisher in France|exploité par l'éditeur en France/);
    }
  });

  // @req REL-LOG-06[badger-desktop,badger-mobile,badger-tv,parrot]
  it("anchors the error-reports item as #error-reports in every language, where the apps' 'What's in a report?' link lands", () => {
    for (const lang of LEGAL_LANGUAGES) {
      const html = renderToStaticMarkup(
        <MemoryRouter initialEntries={[`/${lang}/privacy`]}>
          <Routes>
            <Route path="/:lang/*" element={<LegalPage slug="privacy" />} />
          </Routes>
        </MemoryRouter>,
      );
      const anchored = html.match(/<li id="error-reports"[^>]*>([\s\S]*?)<\/li>/)?.[1] ?? "";
      console.info(`[legal:error-reports-anchor] ${lang}: ${anchored.slice(0, 80)}`);
      expect(html.match(/id="error-reports"/g)).toHaveLength(1);
      expect(anchored).toMatch(/Bugsink/);
    }
  });

  // @req WEB-LEGAL-03[web] @req ACCT-NEWS-01[web]
  it("names the per-subscriber opens and clicks of News emails: what is recorded, never the library, consent, and erasure on unsubscribe", () => {
    const en = pageText(LEGAL_CONTENT.en, "privacy");
    for (const fact of [
      "whether and when you open each News email and which of its links you click",
      "each News email contains a tiny invisible image and links that pass through our server",
      "they never say anything about your library or about what you watch or listen to",
      "Legal basis: your consent (art. 6(1)(a)), given with the News box or switch",
      "The only tracking in our emails is the counting of opens and clicks of the News emails",
      "They are erased when you unsubscribe, turn News off in your account settings or delete your account.",
    ]) {
      expect(en).toContain(fact);
    }
    for (const text of [LEGAL_CONTENT.en.consent.newsBox, LEGAL_CONTENT.en.consent.newsHint]) {
      expect(text).toContain("SpaceFleet counts the opens and clicks of its News emails.");
    }
    for (const lang of LEGAL_LANGUAGES) {
      const items = LEGAL_CONTENT[lang].pages.privacy.sections.flatMap((s) => s.blocks.flatMap((b) => (typeof b === "string" ? [] : b.items)));
      const tracking = items.filter((item) => typeof item !== "string" && item.id === "news-tracking");
      console.info(`[legal:news-tracking] ${lang}: ${tracking.length} item(s)`);
      expect(tracking).toHaveLength(1);
      expect(LEGAL_CONTENT[lang].updated).toMatch(/26/);
    }
  });

  // @req WEB-LEGAL-03[web] @req OPS-BIZ-08[web]
  it("discloses the business records: what is recorded, where a visit came from kept only in the page's memory, legitimate interest, never the library, unlinked at deletion", () => {
    const en = pageText(LEGAL_CONTENT.en, "privacy");
    for (const fact of [
      "the plan you choose and the price you were shown",
      "the version of our price list it came from",
      "which SpaceFleet app and version you used",
      "its utm_ parameters; links from the News to our site carry the name of that News",
      "the name of the site that sent you, never the full address of its page",
      "These records never say anything about your library or about what you watch or listen to",
      "Legal basis: our legitimate interest in running and pricing our business (art. 6(1)(f)); you can object",
      "only in the memory of the open page, writes nothing to your device",
      "When you delete your account, they are unlinked from it",
    ]) {
      expect(en).toContain(fact);
    }
    for (const lang of LEGAL_LANGUAGES) {
      const items = LEGAL_CONTENT[lang].pages.privacy.sections.flatMap((s) => s.blocks.flatMap((b) => (typeof b === "string" ? [] : b.items)));
      const records = items.filter((item) => typeof item !== "string" && item.id === "business-records");
      const text = pageText(LEGAL_CONTENT[lang], "privacy");
      console.info(`[legal:business-records] ${lang}: ${records.length} item(s), utm_ ${text.includes("utm_")}`);
      expect(records).toHaveLength(1);
      expect(text).toContain("utm_");
    }
  });

  // @req WEB-LEGAL-03[web]
  it("names YouTube as the recipient of a trailer the user plays, nothing before, with its data, trackers, ads, legal basis and Google's policy", () => {
    const en = pageText(LEGAL_CONTENT.en, "privacy");
    for (const fact of [
      "Nothing is sent to YouTube before you play a trailer.",
      "YouTube (Google Ireland Limited) receives your IP address, data about your device and your app or browser",
      "it may set cookies and similar trackers, and may show ads before or during the trailer",
      "Legal basis: your consent (art. 6(1)(a)), given each time you choose to play a trailer",
      "an Invidious instance instead",
      "The one exception is a trailer you choose to play",
      "YouTube's player may store cookies and similar data on your device when you play a trailer",
      "Google Ireland Limited (YouTube): plays the trailers you choose to play",
    ]) {
      expect(en).toContain(fact);
    }
    for (const lang of LEGAL_LANGUAGES) {
      const privacy = LEGAL_CONTENT[lang].pages.privacy;
      const items = privacy.sections.flatMap((s) => s.blocks.flatMap((b) => (typeof b === "string" ? [] : b.items)));
      const trailers = items.filter((item) => typeof item !== "string" && item.id === "trailers");
      const text = pageText(LEGAL_CONTENT[lang], "privacy");
      console.info(`[legal:trailers] ${lang}: ${trailers.length} item(s), policy link ${text.split("https://policies.google.com/privacy").length - 1}x`);
      expect(trailers).toHaveLength(1);
      expect(text.split("https://policies.google.com/privacy").length - 1).toBe(2);
      expect(text).toContain("Google Ireland Limited (YouTube)");
    }
  });

  // @req WEB-LEGAL-03[web]
  it("describes title lookups going straight to the metadata service, sent on from our own server without naming where, no CDN for text recognition data and Cloudflare's narrowed role", () => {
    const en = pageText(LEGAL_CONTENT.en, "privacy");
    for (const fact of [
      "sends the title looked up straight to our metadata service",
      "Our main server never receives your lookups",
      "the title is sent from our own server, never with your IP address or any information about you",
      "domain name and DNS for spacefleet.io",
      "The website and the apps' other connections reach our servers directly.",
    ]) {
      expect(en).toContain(fact);
    }
    // The earlier wording: a relay through the main server, the desktop calling a data source, Cloudflare in front of
    // the site. legal.web-apps.test.tsx checks that no data source is named.
    for (const stale of [/main server receives each lookup/, /contacted directly by your desktop app/, /visitors to spacefleet\.io/]) {
      expect(en).not.toMatch(stale);
    }
    for (const lang of LEGAL_LANGUAGES) {
      const text = pageText(LEGAL_CONTENT[lang], "privacy");
      const jsdelivr = text.includes("jsDelivr");
      console.info(`[legal:lookups] ${lang}: jsDelivr ${jsdelivr ? "STILL NAMED" : "absent"}`);
      expect(jsdelivr).toBe(false);
      expect(text).toContain("reports.spacefleet.io");
      // UX-COPY-01 (Chris 2026-11-18): Parrot's lookups are described too, and the reader is pointed to the code that proves the ticket claim.
      expect(text).toContain("SpaceParrot");
      expect(text).toContain("Privacy Pass, RFC 9578");
      expect(text).toContain("packages/privacy-pass");
      expect(text).toContain("packages/metadata-client");
    }
  });
});

describe("account deletion page", () => {
  // @req WEB-LEGAL-04[web] @req WEB-LEGAL-10[web]
  it("gives the in-app paths with the apps' own labels, the email route, and what is deleted or kept", () => {
    // Each app gets these labels from `@space/shared/accountDeletionLabels` at load, as the page does: no app file keeps
    // its own copy, so the page and the app can't drift. legal.web-apps.test.tsx checks the website the same way.
    const apps = [
      { app: "mobile", dir: "packages/mobile-shell/src/i18n", loader: "packages/mobile-shell/src/i18n/index.ts", keys: ["settings.title", "settings.account.title", "settings.account.deleteAccount"] },
      { app: "desktop", dir: "apps/badger/desktop/src/renderer/src/i18n", loader: "apps/badger/desktop/src/renderer/src/i18n/index.ts", keys: ["settings.title", "account.deletion.title"] },
    ] as const;
    const lookup = (tree: Record<string, unknown>, key: string): unknown =>
      key.split(".").reduce<unknown>((node, part) => (node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined), tree);
    for (const { app, dir, loader, keys } of apps) {
      expect(readFileSync(resolve(repo, loader), "utf8")).toContain(`withAccountDeletionLabels(`);
      for (const lang of LEGAL_LANGUAGES) {
        const file = readJson(`${dir}/${lang}.json`);
        const ownCopies = keys.filter((key) => lookup(file, key) !== undefined);
        console.info(`[legal:deletion-labels] ${app} ${lang}: own copies in ${dir}=${JSON.stringify(ownCopies)}`);
        expect(ownCopies).toEqual([]);
        const shown = withAccountDeletionLabels(file, app, lang);
        const path = keys.map((key) => lookup(shown, key)).join(" > ");
        expect(path).toBe(accountDeletionPath(app, lang));
        expect(pageText(LEGAL_CONTENT[lang], "account-deletion")).toContain(path);
      }
    }
    for (const lang of LEGAL_LANGUAGES) {
      const text = pageText(LEGAL_CONTENT[lang], "account-deletion");
      expect(text).not.toContain("{{");
      expect(text).toContain("privacy@spacefleet.io");
      expect(text).not.toContain("contact@spacefleet.io");
      expect(text).toContain("DELETE");
      expect(text).toContain("SpaceBadger");
      expect(text).toContain("SpaceParrot");
    }
    const en = pageText(LEGAL_CONTENT.en, "account-deletion");
    for (const fact of ["no grace period", "within 7 days", "subscription is cancelled", "erased from every storage server", "more than 30 days old", "10 years after the end of the financial year", "30 days"]) {
      expect(en).toContain(fact);
    }
  });
});

describe("terms of service and sale", () => {
  // @req WEB-LEGAL-05[web] @req WEB-LEGAL-08[web] @req WEB-LEGAL-12[web]
  it("covers plans, renewal, withdrawal, unpaid accounts, deletion, liability, changes and disputes", () => {
    const en = pageText(LEGAL_CONTENT.en, "terms");
    for (const fact of [
      "Free (20 GB), Starter (100 GB), Standard (400 GB) and Scale (1000 GB)",
      "500 GB",
      "all taxes included",
      "through Stancer",
      "renews automatically",
      "L215-1",
      "14-day money-back guarantee",
      "Model withdrawal form",
      "Chris-Alexandre Pena, EI (SpaceFleet), 8 bis rue Abel, 75012 Paris, France, contact@spacefleet.io",
      "If a renewal is not paid",
      "L221-18",
      "60 days",
      "7 days and 1 day",
      "L224-25-1",
      "30 days before",
      "French law",
      "consumer mediator",
      "18 or over, or the age of majority where you live if that is higher",
      "supervision of the adult who holds the account",
      "even if you have already used the service",
      "the first subscription, each move to a higher plan and each yearly renewal",
      "the first payment after a move to a smaller plan",
      "Monthly renewals are not covered.",
    ]) {
      expect(en).toContain(fact);
    }
    const fr = pageText(LEGAL_CONTENT.fr, "terms");
    for (const fact of ["Formulaire de rétractation", "Droit de rétractation", "L221-18", "L215-1", "médiateur de la consommation", "droit français"]) {
      expect(fr).toContain(fact);
    }
  });

  // @req WEB-LEGAL-05[web]
  it("offers withdrawal by email or by post to the published address, and by email only when there is none", () => {
    const postal = { en: "by post", fr: "par courrier", de: "per Post", es: "correo postal", nl: "per post" };
    const formTo = { en: "To: ", fr: "À l'attention de ", de: "An ", es: "A la atención de: ", nl: "Aan " };
    for (const lang of LEGAL_LANGUAGES) {
      const text = pageText(LEGAL_CONTENT[lang], "terms");
      console.info(`[legal:postal] ${lang}: postal route shown: ${text.includes(postal[lang])}`);
      expect(text).toContain(`${postal[lang]}`);
      expect(text).toContain(PUBLISHER_POSTAL_ADDRESS);
      expect(text).toContain(`${formTo[lang]}Chris-Alexandre Pena, EI (SpaceFleet), ${PUBLISHER_POSTAL_ADDRESS}, contact@spacefleet.io`);
      expect(text).not.toMatch(/\[\[postal:|\{\{publisherPostalAddress\}\}/);

      const emailOnly = pageText(legalContentFor(lang, null), "terms");
      expect(emailOnly).not.toContain(postal[lang]);
      expect(emailOnly).toContain(`${formTo[lang]}Chris-Alexandre Pena, EI (SpaceFleet), contact@spacefleet.io`);
      expect(emailOnly).not.toMatch(/\[\[postal:|\{\{publisherPostalAddress\}\}/);
    }
  });

  // @req WEB-LEGAL-18[web]
  it("asks for the terms and an immediate start before paying, keeps the full refund, and words the sign-up line", () => {
    for (const lang of LEGAL_LANGUAGES) {
      const { consent } = LEGAL_CONTENT[lang];
      expect(Object.keys(consent).sort()).toEqual(["heading", "news", "newsBox", "newsHint", "required", "signup", "startNow", "terms"]);
      expect(consent.terms).toContain("(page:terms)");
      expect(consent.signup).toContain("(page:terms)");
      expect(consent.signup).toContain("(page:privacy)");
      expect(pageText(LEGAL_CONTENT[lang], "terms")).toContain("L221-25");
      expect(LEGAL_CONTENT[lang].updated).toMatch(/26/);
    }
    expect(LEGAL_CONTENT.fr.consent.terms).toBe("J'accepte les [Conditions générales d'utilisation et de vente](page:terms).");
    expect(LEGAL_CONTENT.fr.consent.startNow).toContain("avant la fin du délai de rétractation de 14 jours");
    expect(LEGAL_CONTENT.fr.consent.startNow).toContain("remboursement intégral, même si j'ai déjà utilisé le service");
    // No waiver wording: the guarantee stays whole, so the box never says the right to withdraw is lost.
    expect(LEGAL_CONTENT.fr.consent.startNow).not.toMatch(/renonce|perds/);
    expect(LEGAL_CONTENT.en.consent.startNow).not.toMatch(/waive|lose/);

    const boxes = renderToStaticMarkup(
      <CheckoutConsentBoxes language="fr" value={NO_CHECKOUT_CONSENT} onChange={() => {}} baseUrl="https://spacefleet.io" />,
    );
    expect(boxes.match(/type="checkbox"/g)).toHaveLength(2);
    expect(boxes).not.toContain("checked");
    expect(boxes).toContain('href="https://spacefleet.io/fr/terms"');
    expect(boxes).toContain('data-given="false"');
    expect(boxes).toContain(LEGAL_CONTENT.fr.consent.required);
    const signup = renderToStaticMarkup(<SignupTermsNotice language="en" />);
    expect(signup).toContain('href="/en/terms"');
    expect(signup).toContain('href="/en/privacy"');
    expect(signup).not.toContain("checkbox");
  });
});

describe("legal pages match the spec on processors, mediator, retention, deletion and language", () => {
  // @req WEB-LEGAL-11[web] @req WEB-LEGAL-07[web] @req WEB-LEGAL-13[web]
  // @req WEB-LEGAL-09[web] @req WEB-LEGAL-10[web] @req WEB-LEGAL-08[web] @req WEB-LEGAL-05[web]
  it("names Amazon SES, CM2C, the accounting retention, the 7-day email deletion, age 18, the yearly-plan rules and the French-prevails line", () => {
    const facts: Record<LegalLanguage, Partial<Record<LegalSlug | "updated", string[]>>> = {
      en: {
        updated: ["If the language versions of this page differ, the French version prevails."],
        privacy: [
          "Amazon Web Services (Amazon SES), from its Paris region (France)",
          "(Cloudflare, Amazon Web Services, Google, Apple)",
          "10 years after the end of the financial year",
          "one month later",
          "18 or over",
        ],
        terms: [
          "CM2C (Centre de la Médiation de la Consommation de Conciliateurs de Justice), 49 rue de Ponthieu, 75008 Paris, France, https://www.cm2c.net",
          "18 or over",
          "same in every country",
          "credit note",
          "at the yearly renewal",
          "14, 7, 3 and 1 days",
          "1, 3 and 7 days",
        ],
        "account-deletion": ["within 7 days", "10 years after the end of the financial year"],
      },
      fr: {
        updated: ["En cas de divergence entre les versions linguistiques de cette page, la version française prévaut."],
        privacy: [
          "Amazon Web Services (Amazon SES), depuis sa région de Paris (France)",
          "(Cloudflare, Amazon Web Services, Google, Apple)",
          "10 ans après la fin de l'exercice comptable",
          "18 ans",
        ],
        terms: [
          "CM2C (Centre de la Médiation de la Consommation de Conciliateurs de Justice), 49 rue de Ponthieu, 75008 Paris, France, https://www.cm2c.net",
          "18 ans",
          "surveillance de l'adulte titulaire du compte",
          "identiques dans tous les pays",
          "avoir",
          "14, 7, 3 et 1 jours",
          "1, 3 et 7 jours",
        ],
        "account-deletion": ["dans un délai de 7 jours", "10 ans après la fin de l'exercice comptable"],
      },
      nl: {
        updated: ["Als de taalversies van deze pagina van elkaar verschillen, heeft de Franse versie voorrang."],
        privacy: [
          "Amazon Web Services (Amazon SES), vanuit zijn regio Parijs (Frankrijk)",
          "(Cloudflare, Amazon Web Services, Google, Apple)",
          "10 jaar na het einde van het boekjaar",
          "een maand later",
          "18 jaar",
          "Foutrapporten: 90 dagen na ontvangst, daarna verwijderd.",
          "Bugsink) die we zelf beheren",
        ],
        terms: [
          "CM2C (Centre de la Médiation de la Consommation de Conciliateurs de Justice), 49 rue de Ponthieu, 75008 Paris, France, https://www.cm2c.net",
          "18 jaar",
          "onder toezicht van de volwassene die het account houdt",
          "gelijk in alle landen",
          "creditnota",
          "bij de jaarlijkse verlenging",
          "14, 7, 3 en 1 dagen",
          "1, 3 en 7 dagen",
          "Modelformulier voor herroeping",
          "ook als je de dienst al hebt gebruikt",
          "Franse recht",
          "consumentenbemiddelaar",
        ],
        "account-deletion": ["binnen 7 dagen", "10 jaar na het einde van het boekjaar"],
      },
      de: {
        updated: ["Weichen die Sprachfassungen dieser Seite voneinander ab, ist die französische Fassung maßgeblich."],
        privacy: [
          "Amazon Web Services (Amazon SES), aus seiner Region Paris (Frankreich)",
          "(Cloudflare, Amazon Web Services, Google, Apple)",
          "10 Jahre nach dem Ende des Geschäftsjahres",
          "einen Monat später",
          "18 Jahre",
          "Fehlerberichte: 90 Tage nach ihrem Eingang, dann gelöscht.",
          "(Bugsink) senden, den wir selbst betreiben",
        ],
        terms: [
          "CM2C (Centre de la Médiation de la Consommation de Conciliateurs de Justice), 49 rue de Ponthieu, 75008 Paris, France, https://www.cm2c.net",
          "18 Jahre",
          "unter Aufsicht der erwachsenen Person nutzen, die das Konto innehat",
          "in allen Ländern gleich",
          "Gutschrift",
          "bei der jährlichen Verlängerung",
          "14, 7, 3 und 1 Tage",
          "1, 3 und 7 Tage",
          "Muster-Widerrufsformular",
          "auch wenn du den Dienst bereits genutzt hast",
          "französischem Recht",
          "Verbraucherschlichtungsstelle",
        ],
        "account-deletion": ["innerhalb von 7 Tagen", "10 Jahre nach dem Ende des Geschäftsjahres"],
      },
      es: {
        updated: ["Si las versiones lingüísticas de esta página difieren, prevalece la versión francesa."],
        privacy: [
          "Amazon Web Services (Amazon SES), desde su región de París (Francia)",
          "(Cloudflare, Amazon Web Services, Google, Apple)",
          "10 años desde el cierre del ejercicio contable",
          "un mes después",
          "18 años",
          "Informes de errores: 90 días desde su recepción; después se eliminan.",
          "(Bugsink) que gestionamos nosotros mismos",
        ],
        terms: [
          "CM2C (Centre de la Médiation de la Consommation de Conciliateurs de Justice), 49 rue de Ponthieu, 75008 Paris, France, https://www.cm2c.net",
          "18 años",
          "bajo la supervisión del adulto titular de la cuenta",
          "son los mismos en todos los países",
          "factura rectificativa",
          "en la renovación anual",
          "14, 7, 3 y 1 días",
          "1, 3 y 7 días",
          "Modelo de formulario de desistimiento",
          "aunque ya haya usado el servicio",
          "legislación francesa",
          "mediador de consumo",
        ],
        "account-deletion": ["en un plazo de 7 días", "10 años desde el cierre del ejercicio contable"],
      },
    };
    for (const lang of LEGAL_LANGUAGES) {
      const content = LEGAL_CONTENT[lang];
      for (const [where, expected] of Object.entries(facts[lang])) {
        const text = where === "updated" ? content.updated : pageText(content, where as LegalSlug);
        const missing = expected!.filter((fact) => !text.includes(fact));
        console.info(`[legal:spec-align] ${lang}/${where}: ${expected!.length - missing.length}/${expected!.length} facts present`);
        if (missing.length) console.info(`[legal:spec-align] ${lang}/${where} missing:\n  ${missing.join("\n  ")}\n--- text ---\n${text}`);
        expect(missing, `${lang} ${where} is missing spec facts`).toEqual([]);
      }
      const all = [content.updated, ...LEGAL_SLUGS.map((slug) => pageText(content, slug))].join("\n");
      // Old wording the spec replaced: age 15, parental permission, deletion "within one month", an unnamed mediator.
      for (const stale of [/15 or over|15 ans/, /parent or guardian|titulaire de l'autorité parentale/, /within one month at most|dans un délai d'un mois au plus/]) {
        console.info(`[legal:spec-align] ${lang}: stale ${stale} ${stale.test(all) ? "FOUND" : "absent"}`);
        expect(all).not.toMatch(stale);
      }
    }
  });
});

describe("inline links", () => {
  // @req WEB-LEGAL-01[web]
  it("turns page links, web addresses and email addresses into links and rejects unknown pages", () => {
    expect(parseLegalInline("See the [policy](page:privacy) or write to contact@spacefleet.io. Visit https://www.cnil.fr.")).toEqual([
      { kind: "text", text: "See the " },
      { kind: "page", text: "policy", slug: "privacy" },
      { kind: "text", text: " or write to " },
      { kind: "url", text: "contact@spacefleet.io", href: "mailto:contact@spacefleet.io" },
      { kind: "text", text: ". Visit " },
      { kind: "url", text: "https://www.cnil.fr", href: "https://www.cnil.fr" },
      { kind: "text", text: "." },
    ]);
    expect(() => parseLegalInline("[x](page:nope)")).toThrow(/unknown legal page/);
  });
});
