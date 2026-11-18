import { decryptContentObject } from "./encryption";

export type ReadEncryptedContentObjectArgs = {
  objectKey: string;
  contentKeyBase64: string;
  downloadObject: (objectKey: string) => Promise<Uint8Array>;
};

export const readEncryptedContentObject = async (args: ReadEncryptedContentObjectArgs) => {
  const encrypted = await args.downloadObject(args.objectKey);
  return decryptContentObject(encrypted, args.contentKeyBase64);
};
