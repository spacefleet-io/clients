// Generates tests/vectors.json from the TypeScript reference implementations.
// Run from the repo root: bun apps/badger/kodi/tests/gen_vectors.ts
import { createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { encryptBytesToBytes } from "../../../../packages/library-db-runtime/src/crypto";
import {
  deriveMediaMasterKey,
  deriveObjectKey,
  setMediaMasterKey,
  encryptMediaObject,
  decryptMediaObject,
} from "../../desktop/src/main/mediaCrypto";

const libraryKey = randomBytes(32);
const libraryKeyB64 = libraryKey.toString("base64");
const master = deriveMediaMasterKey(libraryKey);
setMediaMasterKey(master);
const salt = randomBytes(16);
const objKey = deriveObjectKey(master, salt);

const envelopeMsg = Buffer.from(JSON.stringify({ id: "op-1", type: "setting.set", payload: { key: "k", value: "v" } }));
const envelope = await encryptBytesToBytes(libraryKeyB64, envelopeMsg);

const mediaPlain = randomBytes(5000);
const sfv1 = encryptMediaObject(mediaPlain, 700);
const roundTrip = await decryptMediaObject(Buffer.from(sfv1));
if (!roundTrip.plaintext.equals(mediaPlain)) throw new Error("TS round trip failed");

const opId = "00000000-0000-4000-8000-000000000001";
const prev = "ab".repeat(32);
const payloadHash = createHash("sha256").update(envelope).digest("hex");
const nextStateHash = createHash("sha256").update(`${prev}|${opId}|${payloadHash}`).digest("hex");

writeFileSync(
  new URL("./vectors.json", import.meta.url),
  JSON.stringify(
    {
      libraryKeyB64,
      masterKeyHex: master.toString("hex"),
      hkdfSaltHex: salt.toString("hex"),
      objectKeyHex: objKey.toString("hex"),
      envelopePlainB64: envelopeMsg.toString("base64"),
      envelopeHex: Buffer.from(envelope).toString("hex"),
      mediaPlainB64: mediaPlain.toString("base64"),
      sfv1Hex: Buffer.from(sfv1).toString("hex"),
      stateHash: { opId, prev, envelopeHex: Buffer.from(envelope).toString("hex"), next: nextStateHash },
    },
    null,
    2,
  ),
);
console.log("vectors written");
