// @req INGS-IDENT-03
// What the add-to-library dialog says for each way a title search can fail, and the real English and French text of the
// ticket-limit message (Badger 0.1.12 release smoke, CI run 37925: an account's hourly ticket ceiling showed as
// "the app could not reach title search").
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MetadataRequestError, MetadataUnavailableError, NoTicketError, TicketRejectedError } from "@space/metadata-client";
import { frenchTypographyProblems } from "@space/shared/frenchTypography";
import i18next from "i18next";
import { describe, expect, it } from "vitest";
import { MetadataLookupTimeoutError } from "../src/renderer/src/lib/metadataRetry";
import { searchFailureText, type SearchFailureText } from "../src/renderer/src/lib/metadataSearchError";

const SUITE = "metadata-search-error";

const translator = async (code: "en" | "fr") => {
  const translation = JSON.parse(readFileSync(resolve(import.meta.dirname, `../src/renderer/src/i18n/${code}.json`), "utf8")) as Record<string, unknown>;
  const instance = i18next.createInstance();
  await instance.init({ lng: code, resources: { [code]: { translation } }, interpolation: { escapeValue: false } });
  return instance;
};

describe("searchFailureText @req INGS-IDENT-03", () => {
  it("[@bugfix][@regression-proof] a 429 ticket refusal says the account's limit was reached, with the minutes until the app asks again", () => {
    const failure = searchFailureText(new NoTicketError({ status: "rate_limited", retryAfterSeconds: 690 }));
    console.info(`[${SUITE}:ticket-limit] ${JSON.stringify(failure)}`);
    expect(failure).toEqual({ error: "ingestion.errors.ticketLimit", hint: "ingestion.ui.ticketLimitHint", values: { minutes: 12 }, retryOnTickets: true });
    // Less than a minute left still shows 1 min, never "0 min".
    const soon = searchFailureText(new NoTicketError({ status: "rate_limited", retryAfterSeconds: 0 }));
    console.info(`[${SUITE}:ticket-limit] retry-after 0 -> ${JSON.stringify(soon)}`);
    expect(soon.values).toEqual({ minutes: 1 });
  });

  it("keeps \"could not reach title search\" for a refill that never got an answer, and a neutral line for every other refusal", () => {
    const cases: [string, unknown, SearchFailureText][] = [
      ["network_error", new NoTicketError({ status: "network_error" }), { error: "ingestion.errors.metadataUnavailable", hint: "ingestion.ui.metadataUnavailableHint", retryOnTickets: true }],
      ["429 with no retry time (a refill run outside the schedule)", new NoTicketError({ status: "rate_limited" }), { error: "ingestion.errors.metadataUnavailable", hint: "ingestion.ui.metadataNotLookedUpHint", retryOnTickets: true }],
      ["key_mismatch", new NoTicketError({ status: "key_mismatch" }), { error: "ingestion.errors.metadataUnavailable", hint: "ingestion.ui.metadataNotLookedUpHint", retryOnTickets: true }],
      ["no shortage", new NoTicketError(), { error: "ingestion.errors.metadataUnavailable", hint: "ingestion.ui.metadataNotLookedUpHint", retryOnTickets: true }],
      ["ticket rejected", new TicketRejectedError(), { error: "ingestion.errors.metadataUnavailable", hint: "ingestion.ui.metadataNotLookedUpHint", retryOnTickets: true }],
      ["lookup 429", new MetadataUnavailableError(429, 30), { error: "ingestion.errors.metadataUnavailable", hint: "ingestion.ui.metadataNotLookedUpHint", retryOnTickets: true }],
      ["timeout", new MetadataLookupTimeoutError(15_000), { error: "ingestion.errors.searchTimedOut", hint: "ingestion.ui.searchTimedOutHint", retryOnTickets: false }],
      ["lookup 500", new MetadataRequestError(500), { error: "ingestion.errors.searchFailed", hint: "ingestion.ui.searchFailedHint", retryOnTickets: false }],
    ];
    for (const [label, error, expected] of cases) {
      const failure = searchFailureText(error);
      console.info(`[${SUITE}:mapping] ${label} -> ${JSON.stringify(failure)}`);
      expect(failure, label).toEqual(expected);
    }
  });

  it("renders the ticket-limit message in English and French, with the minutes filled in and French spacing kept", async () => {
    const failure = searchFailureText(new NoTicketError({ status: "rate_limited", retryAfterSeconds: 25 * 60 }));
    const texts: Record<string, { error: string; hint: string }> = {};
    for (const code of ["en", "fr"] as const) {
      const t = (await translator(code)).t;
      texts[code] = { error: t(failure.error), hint: t(failure.hint, failure.values) };
      console.info(`[${SUITE}:render] ${code}: ${texts[code].error} | ${texts[code].hint}`);
    }
    expect(texts.en).toEqual({
      error: "Title search limit reached for now",
      hint: "This file was not looked up yet: this account asked for too many title searches this hour. The app tries again in about 25 min.",
    });
    expect(texts.fr).toEqual({
      error: "Limite de recherche de titres atteinte pour le moment",
      hint: "Ce fichier n'a pas encore été recherché\u202f: ce compte a demandé trop de recherches de titres cette heure-ci. L'app réessaiera dans environ 25 min.",
    });
    expect(texts.en.hint).not.toContain("could not reach");
    expect(frenchTypographyProblems(texts.fr)).toEqual([]);
  });
});
