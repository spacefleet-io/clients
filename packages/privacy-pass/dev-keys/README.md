# Development signing key (public, insecure)

`dev-signing-key.pem` is a **throwaway RSA-2048 private key committed on purpose**. It is public and gives no protection: it exists so dev setups and tests can sign tickets that dev builds accept: those pin `DEV_TICKET_KEY` (`ticketKeyForBuild(true)`, see `../README.md` "Pinned key"). Released apps pin the production `PINNED_TICKET_KEY` and drop tickets signed with this key (META-ANON-06).

- `dev-signing-key.pub.pem` is its public half (`openssl pkey -in dev-signing-key.pem -pubout`). It is committed with `git add -f` (`*.pem` is ignored). The production metadata service refuses the dev key.
- NEVER use it in production or anywhere real tickets matter.
- The production signing key is generated outside the repository, lives only in the server's secrets and is never committed.
- Replacing this key means regenerating `src/pinnedKey.ts` `vectors/dev-token.json` and `DEV_TICKET_KEY_ID`.
