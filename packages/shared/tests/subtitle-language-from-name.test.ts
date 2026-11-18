import { describe, expect, it } from "vitest";
import { subtitleLanguageFromName } from "../src/libraryTypes";

// @req INGS-SUBS-01
describe("subtitle language from the file name (INGS-SUBS-01)", () => {
  it("reads the first alias or two-letter media language code of the name, und when none", () => {
    const names = [
      "Movie.fr.srt",
      "movie_french.srt",
      "Film.Français.srt",
      "film.ger.srt",
      "Movie.2019.eng.srt",
      "Serie.esp.vtt",
      "Film.nld.srt",
      "Movie.de.la.Nuit.fr.srt",
      "movie.es.srt",
      "Film.Nederlands.vtt",
      "plain.srt",
    ];
    const guesses = Object.fromEntries(names.map((name) => [name, subtitleLanguageFromName(name)]));
    console.info(`[subtitle-language] ${JSON.stringify(guesses)}`);
    expect(guesses).toEqual({
      "Movie.fr.srt": "fr",
      "movie_french.srt": "fr",
      "Film.Français.srt": "fr",
      "film.ger.srt": "de",
      "Movie.2019.eng.srt": "en",
      "Serie.esp.vtt": "es",
      "Film.nld.srt": "nl",
      "Movie.de.la.Nuit.fr.srt": "de",
      "movie.es.srt": "es",
      "Film.Nederlands.vtt": "und",
      "plain.srt": "und",
    });
  });
});
