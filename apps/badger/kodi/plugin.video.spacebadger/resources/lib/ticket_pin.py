# -*- coding: utf-8 -*-
"""The ticket signing keys this add-on knows (META-ANON-03, META-ANON-06). GENERATED from packages/privacy-pass/src/pinnedKey.ts
(PINNED_TICKET_KEY and DEV_TICKET_KEY): do not edit by hand, run apps/badger/kodi/tools/sync_ticket_pin.py.
tests/test_ticket_pin.py fails when this file and the TypeScript keys differ. The add-on pins the PRODUCTION key; the
public development key (packages/privacy-pass/dev-keys/) only with the explicit dev opt-in SB_DEV_TICKET_KEY=1."""

# token_key_id: SHA-256 of the RSASSA-PSS SubjectPublicKeyInfo DER (RFC 9578 section 6.5), lowercase hex.
PINNED_KEY_ID = "9b305f0d75ab31dae50752aa4aaf069589ba013894db912b8b5a4b14d773c41a"
# RSA-2048 modulus, lowercase hex (the exponent is always 65537).
PINNED_MODULUS_HEX = (
    "db4f1a569982700371c779a91bd7ebdd930a62fda84b9d19bcbe9591ff7ae2e6"
    "ff88bfa102638d0647060ac86a07818b3544349615ccfd972775cfe91da440a4"
    "7fe9e3ddd11ad793c2fd32a672cb8f49ed02b24b95f65c1c3c939f246f188108"
    "ea13927d825564fe196a8cc416d49d3aabf8a58c4135fab2ea37f722c8945b6c"
    "eb7a04497a396fa55504e668e37d6b215136e82c84376a2ed82de57af95e98ed"
    "a77bb90d59ba6f136e60e0ada90a94e260346bce7f4bb0fc1d78126274c2519b"
    "dbc20d1e1587e4cc83fd912ef91d0a3d235829d7d8e484f44e2980c3cd836404"
    "cb69ede1c4bf83a36836704e25fa05429a10bd93e464a00ee7bc0bf4924eea95"
)

# The committed development key, same encoding.
DEV_KEY_ID = "26ee128877c6fa8a8662f1d40942bb9fa620b51148475d0d35b82eb94561641d"
DEV_MODULUS_HEX = (
    "a9e6232da3d487aae31584e4f624177d77db7d828de21e97ff6a158e7c0bb547"
    "8e016356f742d88a8c9c4378baa77aa52e4c0755ef3df9d7eb75ce2e999d9044"
    "004b13104fb2d9aa3b212cb724d1491102c8860f9a44c4084e7bb0c395f438d1"
    "de21d999bcc8800be5b8aee05376a86de363f9cba58768953f223a905d4cd1fc"
    "17a7f84f62f025ca39666cd3b89ac8b26ba066358d08213b40a488cf451a0816"
    "d3d0664742c5c8c4698d1ecb10e6c0e94f0cc33f98e937a7d6bebe42c62c72a1"
    "6ca782b9bc0ecd40a90b99fe0f84e4680277983022c1409ba12c62aeb404b962"
    "2e270f1e6aaaa5c2d388f898af32d66e013fb0c6aef77707e2187832cb6f57f3"
)
