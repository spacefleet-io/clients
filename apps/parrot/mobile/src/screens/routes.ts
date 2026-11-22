import type { ParrotCoverKeys } from "@space/parrot-core";

export type RootStack = {
  /** The Home, Library, Playlists and Settings tabs. */
  Main: undefined;
  /** `cover`: the album's cover keys, so its page shows the large copy (over the small one already kept). */
  Album: { albumId: string; title: string; artistName: string; cover?: ParrotCoverKeys | null };
  Artist: { artistId: string; name: string };
  /** One playlist's songs; `name` titles the page while they load. */
  Playlist: { playlistId: string; name: string };
  Player: undefined;
  /** `code` comes from a pairing link (ACCT-PAIR-06); absent when opened from Settings. */
  PairDevice: { code?: string } | undefined;
  /** "Who's listening?" from Settings: `pick` switches, `manage` adds, edits and deletes (UX-PROF-01, ACCT-PROF-05). */
  Profiles: { mode: "pick" | "manage" };
  /** Settings → Delete account (ACCT-DEL-01/02/03). */
  DeleteAccount: undefined;
  /** Settings → Manage offline content (OFFL-MANAGE-01). */
  OfflineContent: undefined;
};
