import { readEncryptedContentObject } from "@space/content-core";

export const readRuntimeContentObject = async (args: {
  objectKey: string;
  contentKeyBase64: string;
  downloadObject: (objectKey: string) => Promise<Uint8Array>;
}) =>
  readEncryptedContentObject({
    objectKey: args.objectKey,
    contentKeyBase64: args.contentKeyBase64,
    downloadObject: args.downloadObject,
  });
