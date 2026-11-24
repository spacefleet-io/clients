// @vitest-environment jsdom
/**
 * Badger count strings take the right plural form: "1 episode" / "2 episodes", "Lancer 1 transcodage" / "Lancer 2 transcodages".
 * The real English and French bundles go through the real i18next, so a count key left with one form fails here.
 */
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createInstance, type i18n as I18n } from "i18next";
import { I18nextProvider, useTranslation } from "react-i18next";
import { afterEach, describe, expect, it } from "vitest";
import en from "../src/renderer/src/i18n/en.json";
import fr from "../src/renderer/src/i18n/fr.json";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const SUITE = "count-plurals";

const KEYS = [
  "library.seasons.episodeCount",
  "library.qualities.addModalConfirm",
  "lab.storage.fileCount",
  "ingestion.ui.blockerMatchOrRemove",
  "ingestion.ui.videoDecisionsPending",
] as const;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const makeI18n = async (lng: "en" | "fr"): Promise<I18n> => {
  const instance = createInstance();
  await instance.init({
    lng,
    fallbackLng: "en",
    resources: { en: { translation: en }, fr: { translation: fr } },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
  return instance;
};

const Counts = ({ count }: { count: number }) => {
  const { t } = useTranslation();
  return (
    <ul>
      {KEYS.map((key) => (
        <li key={key}>{t(key, { count })}</li>
      ))}
    </ul>
  );
};

/** Each key's text at `count`, in KEYS order. */
const renderCounts = async (lng: "en" | "fr", count: number): Promise<string[]> => {
  const instance = await makeI18n(lng);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(
      <I18nextProvider i18n={instance}>
        <Counts count={count} />
      </I18nextProvider>,
    ),
  );
  const texts = Array.from(container.querySelectorAll("li")).map((el) => el.textContent ?? "");
  console.info(`[${SUITE}:${lng}-${count}] texts=${JSON.stringify(texts)}`);
  return texts;
};

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("Badger count strings", () => {
  it("use the singular at 1 in English", async () => {
    expect(await renderCounts("en", 1)).toEqual([
      "1 episode",
      "Queue 1 transcode",
      "1 file",
      "Match or remove 1 unmatched file.",
      "1 video decision pending",
    ]);
  });

  it("use the plural at 2 in English", async () => {
    expect(await renderCounts("en", 2)).toEqual([
      "2 episodes",
      "Queue 2 transcodes",
      "2 files",
      "Match or remove 2 unmatched files.",
      "2 video decisions pending",
    ]);
  });

  it("use the singular at 1 in French", async () => {
    expect(await renderCounts("fr", 1)).toEqual([
      "1 épisode",
      "Lancer 1 transcodage",
      "1 fichier",
      "Associez ou retirez 1 fichier non associé.",
      "1 décision vidéo en attente",
    ]);
  });

  it("use the plural at 2 in French", async () => {
    expect(await renderCounts("fr", 2)).toEqual([
      "2 épisodes",
      "Lancer 2 transcodages",
      "2 fichiers",
      "Associez ou retirez 2 fichiers non associés.",
      "2 décisions vidéo en attente",
    ]);
  });
});
