# `@space/privacy-pass`

Anonymous lookup tickets (Privacy Pass, RFC 9578 token type `0x0002`, publicly verifiable blind RSA, RFC 9474 `RSABSSA-SHA384-PSS-Deterministic`). Specs: META-ANON-02, META-ANON-03. Contract: tracking issue #403.

- Token = `0x0002 || nonce(32) || challenge_digest(32) || token_key_id(32) || authenticator(256)` = 354 bytes, sent as `Authorization: PrivateToken token="<base64url>"`.
- Challenge is one constant for everyone (`issuer_name = "metadata.spacefleet.io"`, empty context and origin); `token_key_id` = SHA-256 of the RSASSA-PSS SPKI DER of the signing key (RFC 9578 section 6.5); RSA-2048, e = 65537.
- The API signs blinded values (never sees a token); the metadata service verifies with the public key only; apps pin one key and drop any ticket that does not verify against it.

## Entries

`@space/privacy-pass` is the portable client: pure TS, BigInt + `@noble/hashes`, no `node:*` (a test walks its import graph). Randomness comes from `globalThis.crypto.getRandomValues` unless a `getRandomBytes` is injected.

```ts
createTicketRequests(count: number, pinnedKey?: PinnedTicketKey, options?: { getRandomBytes? }): { blinded: string[]; pending: PendingTicket[] }
finishTickets(pending: readonly PendingTicket[], signed: readonly string[], pinnedKey?: PinnedTicketKey, options?: { responseKeyId?: string }): { tokens: string[]; dropped: number }  // never throws on a bad server response: a non-array `signed` or a non-string `responseKeyId` drops the batch
privateTokenAuthorization(token: Uint8Array | string): string
parsePrivateTokenAuthorization(header: string | null | undefined): Uint8Array | null
```

The signer and server-side verifier are a separate server-side package, not part of this repo. For reference, its surface (Node/Bun, `node:crypto`):

```ts
loadSigningKey(pemOrFile: string): TicketSigningKey   // API
blindSign(key: TicketSigningKey, blindedMsg: Uint8Array): Uint8Array
loadPublicKey(pemOrFile: string): TicketPublicKey     // metadata service
verifyToken(token: Uint8Array, keys: TicketPublicKey | readonly TicketPublicKey[]): { ok: true; nonce; keyId } | { ok: false; reason }
keyIdOf(spkiDer: Uint8Array): string
```

`verifyToken` does not track replay: the caller records `nonce` as spent.

## Pinned key

`PINNED_TICKET_KEY` (`src/pinnedKey.ts`) is the one key released apps trust, with no spare key (META-ANON-07): the **production** key (META-ANON-06, keyId `9b305f0d75ab31dae50752aa4aaf069589ba013894db912b8b5a4b14d773c41a`), whose private half exists only in the server's encrypted deploy secrets. `DEV_TICKET_KEY` is the public **development** key whose private half is committed in `dev-keys/dev-signing-key.pem` (see `dev-keys/README.md`). `ticketKeysForBuild(devBuild)` returns `[PINNED_TICKET_KEY]` for a release build and `[DEV_TICKET_KEY, PINNED_TICKET_KEY]` (every environment's key, so a dev build's server picker can point at any server) only for `devBuild === true`, and each app passes a flag fixed at build time, never a guess from the URL it talks to: desktop `import.meta.env.DEV` or a `build:test` build (`VITE_SF_DEV_TICKET_KEY=1`, refused by `package`), mobile and TV `__DEV__` or a `profile` build made with `SF_DEV_TICKET_KEY=1` (inlined at build time, refused for release builds), the Jellyfin sidecar `HEADLESS_DEV_TICKET_KEY=1`. The Kodi add-on carries both keys in its generated `ticket_pin.py`; `privacypass.keys_for_run()` trusts the production key alone, or both (dev first, like `ticketKeysForBuild(true)`) only with `SB_DEV_TICKET_KEY=1`. Tests that sign with the dev key pass `DEV_TICKET_KEY` explicitly; `createTicketRequests` defaults to the production key and `createTicketReserve` to `[PINNED_TICKET_KEY]`.

### Refusing the dev key

The dev private key is public, so a deployment must never trust or sign with it. Both entries export `DEV_TICKET_KEY_ID` (its `token_key_id`, lowercase hex) and `isDevTicketKeyId(keyId: string): boolean` so a service can refuse it in production (`isDevTicketKeyId(key.keyId)` on a loaded `TicketPublicKey`). The package itself never refuses it: dev setups and tests rely on it. The metadata service enforces the production check.

## Rotation

A new key means a new pinned constant in the apps, rolled out in this order: (1) the metadata service is configured with the old and the new public key (the list accepted by `verifyToken`); (2) app builds pinning the new key ship; (3) only then does the API switch to the new private key, so no app ever receives tickets signed by a key it does not pin; (4) the old public key stays at the service until reserves signed under it are spent. Tickets do not expire, so that tail is bounded by reserve size and app update uptake, not by a TTL. An app that pins the new key drops anything signed by the old one at its next refill.

## Vectors

- `vectors/rfc9474-a3.json`: RFC 9474 appendix A.3 (RSA-4096), `vectors/rfc9578-a2.json`: RFC 9578 appendix A.2 (five RSA-2048 token issuances). Both extracted verbatim from the RFC text and driven through the code in `tests/`.
- `vectors/dev-token.json`: a complete deterministic issuance under the dev key (nonce, salt, EMSA-PSS encoded message, blinding factor `r` and its inverse, blinded message, blind signature, token, public key, invalid tokens for every `verifyToken` reason). `publicKey.keyIdHex` is the SHA-256 of `publicKey.spkiDerHex` (the RSASSA-PSS SPKI), not of the DER inside `rsaEncryptionPem` for the Kodi Python implementation. A test fails when it drifts.

## Test

`bun run --cwd packages/privacy-pass test` (runs vitest under Bun, the production runtime; `bunx vitest run` runs it under Node and passes too).
