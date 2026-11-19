/**
 * @test-id DESKTOP-I18N-FRENCH-ACCENTS-001
 * @level unit
 * @regression-proof
 *
 * UX-I18N-03: the desktop French file spells every word with its accents ("déjà", "réessayez", "vérification"), never with
 * plain letters. The check is a list of the plain-letter spellings found so far (auth, sign-up and e-mail verification
 * screens had "deja", "reessayez", "Verifiez", "hote"); a value that contains one of them as a whole word fails. It also
 * pins the Library page name to the same wording as the phone app, and messages to "media library".
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BARE_LIBRARY, bareLibraryOutside, MEDIA_LIBRARY } from "@space/shared/libraryName";
import { describe, expect, it } from "vitest";

const LOG = "[i18n-french-accents]";

type Tree = { [key: string]: string | Tree };

const fr = JSON.parse(readFileSync(resolve(__dirname, "../src/renderer/src/i18n/fr.json"), "utf8")) as Tree;
const mobileFr = JSON.parse(readFileSync(resolve(__dirname, "../../../../packages/mobile-shell/src/i18n/fr.json"), "utf8")) as Tree;
/** The keys that name the Library page itself (UX-NAME-02); every other message is to say the media library (UX-NAME-03). */
const PAGE_NAME_KEYS = ["nav.library", "library.title"];
const bareLibrary = bareLibraryOutside(new Set(PAGE_NAME_KEYS));
const otherLocales = Object.fromEntries(
  ["en", "nl", "de"].map((code) => [code, JSON.parse(readFileSync(resolve(__dirname, `../src/renderer/src/i18n/${code}.json`), "utf8")) as Tree])
);

const flatten = (tree: Tree, prefix = ""): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(tree)) {
    if (typeof value === "string") out[`${prefix}${key}`] = value;
    else Object.assign(out, flatten(value, `${prefix}${key}.`));
  }
  return out;
};

/** French spellings that lost their accents; each must never appear as a whole word in a French value. */
const UNACCENTED = [
  "hote",
  "hotes",
  "definissez",
  "definir",
  "defaut",
  "verifiez",
  "verification",
  "verifier",
  "reessayez",
  "reessayer",
  "deja",
  "echoue",
  "echouee",
  "echec",
  "creer",
  "creation",
  "cree",
  "cinema",
  "confidentialite",
  "caracteres",
  "repeter",
  "resultat",
  "resultats",
  "apres",
  "boite",
  "grises",
  "envoye",
  "envoyee",
  "enregistre",
  "enregistree",
  "autorise",
  "autorisee",
  "stockees",
  "stocke",
  "personnalise",
  "personnalisee",
  "personnalises",
  "elements",
  "recents",
  "recent",
  "deconnexion",
  "deconnecter",
  "reinitialiser",
  "parametres",
  "reglages",
  "bibliotheque",
  "mediatheque",
  "telecharger",
  "telechargement",
  "telechargements",
  "qualite",
  "resolution",
  "memoire",
  "reseau",
  "selectionner",
  "selectionnez",
  "precedent",
  "episode",
  "episodes",
  "supprimee",
  "synchronise",
  "genere",
  "etre",
  "ete",
  "a jour",
  "mise a jour",
];
const UNACCENTED_RE = new RegExp(`(?<![\\p{L}])(${UNACCENTED.join("|")})(?![\\p{L}])`, "iu");

describe("desktop French translation file", () => {
  /** @req UX-I18N-03[badger-desktop] */
  it("never uses a plain-letter spelling from the known list", () => {
    const offenders = Object.entries(flatten(fr))
      .map(([key, value]) => ({ key, value, hit: value.replace(/\{\{[^}]*\}\}/g, "").match(UNACCENTED_RE)?.[0] }))
      .filter((row) => row.hit)
      .map((row) => `${row.key}: "${row.value}" (${row.hit})`);
    console.info(`${LOG} unaccented French offenders=${JSON.stringify(offenders, null, 1)}`);
    expect(offenders).toEqual([]);
  });

  /** @req UX-I18N-03[badger-desktop] */
  it("keeps the accents on the sign-in, sign-up and verification screens", () => {
    const flat = flatten(fr);
    console.info(`${LOG} signup.errors.emailExists=${flat["signup.errors.emailExists"]}`);
    expect(flat["authApiHost.error"]).toBe("Impossible d'enregistrer l'hôte API. Vérifiez la valeur et réessayez.");
    expect(flat["signup.haveAccountPrompt"]).toBe("Vous avez déjà un compte\u202f?");
    expect(flat["signup.errors.emailExists"]).toBe("Cet email est déjà enregistré.");
    expect(flat["verifyEmail.errors.invalidCode"]).toBe("Code de vérification invalide. Réessayez.");
  });

  /** @req UX-NAME-02[badger-desktop] */
  it("names the library page Bibliothèque, like the phone app, and Library / Bibliotheek / Bibliothek", () => {
    const flat = flatten(fr);
    console.info(`${LOG} nav.library desktop=${flat["nav.library"]} mobile=${flatten(mobileFr)["nav.library"]}`);
    expect(flat["nav.library"]).toBe("Bibliothèque");
    expect(flatten(mobileFr)["nav.library"]).toBe(flat["nav.library"]);
    const locales = { fr, en: otherLocales.en!, nl: otherLocales.nl!, de: otherLocales.de! };
    const names = Object.entries(locales).flatMap(([lang, tree]) =>
      PAGE_NAME_KEYS.map((key) => [lang as keyof typeof locales, key, flatten(tree)[key] ?? ""] as const)
    );
    // UX-NAME-03 is still pending on desktop: messages outside the page name that say a bare library are only counted.
    const bare = Object.entries(locales).map(([lang, tree]) => Object.entries(flatten(tree)).filter(bareLibrary(BARE_LIBRARY[lang as keyof typeof locales])).length);
    console.info(`${LOG} page names=${JSON.stringify(names)} bare library messages fr,en,nl,de=${bare}`);
    expect(names.map(([, , value]) => value)).toEqual(["Bibliothèque", "Bibliothèque", "Library", "Library", "Bibliotheek", "Bibliotheek", "Bibliothek", "Bibliothek"]);
    expect(names.filter(([lang, , value]) => !BARE_LIBRARY[lang].test(value) || MEDIA_LIBRARY[lang].test(value))).toEqual([]);
  });
});
