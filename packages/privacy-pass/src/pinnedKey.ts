/** The one ticket signing key an app trusts: RSA-2048 modulus and its token_key_id, both lowercase hex (e is always 65537). */
export interface PinnedTicketKey {
  /** token_key_id: SHA-256 of the RSASSA-PSS SubjectPublicKeyInfo DER (RFC 9578 section 6.5). */
  keyId: string;
  modulusHex: string;
}

/**
 * token_key_id of the public DEVELOPMENT key whose private half is committed in `dev-keys/dev-signing-key.pem`.
 * A service holding ticket keys compares against it to refuse the dev key in production.
 */
export const DEV_TICKET_KEY_ID = "26ee128877c6fa8a8662f1d40942bb9fa620b51148475d0d35b82eb94561641d";

/** True when `keyId` (hex token_key_id, any case) is the committed, publicly known dev key. */
export const isDevTicketKeyId = (keyId: string): boolean => keyId.toLowerCase() === DEV_TICKET_KEY_ID;

/**
 * The public DEVELOPMENT key (private half committed in `dev-keys/dev-signing-key.pem`, insecure on purpose):
 * dev setups and the tests sign with it. Only a development build trusts it, chosen at build time
 * (META-ANON-06, META-ANON-07, see {@link ticketKeysForBuild}); a released build never does.
 */
export const DEV_TICKET_KEY: PinnedTicketKey = {
  keyId: DEV_TICKET_KEY_ID,
  modulusHex:
    "a9e6232da3d487aae31584e4f624177d77db7d828de21e97ff6a158e7c0bb5478e016356f742d88a8c9c4378baa77aa52e4c0755ef3df9d7eb75ce2e999d9044004b13104fb2d9aa3b212cb724d1491102c8860f9a44c4084e7bb0c395f438d1de21d999bcc8800be5b8aee05376a86de363f9cba58768953f223a905d4cd1fc17a7f84f62f025ca39666cd3b89ac8b26ba066358d08213b40a488cf451a0816d3d0664742c5c8c4698d1ecb10e6c0e94f0cc33f98e937a7d6bebe42c62c72a16ca782b9bc0ecd40a90b99fe0f84e4680277983022c1409ba12c62aeb404b9622e270f1e6aaaa5c2d388f898af32d66e013fb0c6aef77707e2187832cb6f57f3",
};

/**
 * The key apps pin (META-ANON-03): the PRODUCTION ticket signing key (META-ANON-06). Its private half exists only in
 * the server's encrypted deploy secrets.
 * Every released build pins it. Callers may pass any other PinnedTicketKey to createTicketRequests / finishTickets.
 */
export const PINNED_TICKET_KEY: PinnedTicketKey = {
  keyId: "9b305f0d75ab31dae50752aa4aaf069589ba013894db912b8b5a4b14d773c41a",
  modulusHex:
    "db4f1a569982700371c779a91bd7ebdd930a62fda84b9d19bcbe9591ff7ae2e6ff88bfa102638d0647060ac86a07818b3544349615ccfd972775cfe91da440a47fe9e3ddd11ad793c2fd32a672cb8f49ed02b24b95f65c1c3c939f246f188108ea13927d825564fe196a8cc416d49d3aabf8a58c4135fab2ea37f722c8945b6ceb7a04497a396fa55504e668e37d6b215136e82c84376a2ed82de57af95e98eda77bb90d59ba6f136e60e0ada90a94e260346bce7f4bb0fc1d78126274c2519bdbc20d1e1587e4cc83fd912ef91d0a3d235829d7d8e484f44e2980c3cd836404cb69ede1c4bf83a36836704e25fa05429a10bd93e464a00ee7bc0bf4924eea95",
};

const RELEASE_TICKET_KEYS: readonly PinnedTicketKey[] = Object.freeze([PINNED_TICKET_KEY]);
const DEV_BUILD_TICKET_KEYS: readonly PinnedTicketKey[] = Object.freeze([DEV_TICKET_KEY, PINNED_TICKET_KEY]);

/**
 * The keys a build trusts (META-ANON-06, META-ANON-07). A released build trusts exactly one key, {@link PINNED_TICKET_KEY}
 * (no spare key). A development build trusts the key of every environment, {@link DEV_TICKET_KEY} first, so whichever
 * API server its server picker points at, the tickets verify. `devBuild` must be fixed when the app is built (Vite `DEV`,
 * React Native `__DEV__`, an explicit dev marker the dev stack sets), never inferred at run time from a URL or a server answer.
 */
export const ticketKeysForBuild = (devBuild: boolean): readonly PinnedTicketKey[] =>
  devBuild === true ? DEV_BUILD_TICKET_KEYS : RELEASE_TICKET_KEYS;
