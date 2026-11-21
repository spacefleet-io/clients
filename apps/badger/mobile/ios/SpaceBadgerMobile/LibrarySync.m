#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

// Exposes the Swift `LibrarySync` class (LibrarySync.swift) to React Native.
@interface RCT_EXTERN_MODULE (LibrarySync, RCTEventEmitter)

RCT_EXTERN_METHOD(encryptSnapshotFile
                  : (NSString *)dbPath keyBase64
                  : (NSString *)keyBase64 outputPath
                  : (NSString *)outputPath resolve
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(decryptSnapshotFile
                  : (NSString *)sourcePath keyBase64
                  : (NSString *)keyBase64 dbPath
                  : (NSString *)dbPath resolve
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(openOpPayloadToFile
                  : (NSString *)payloadBase64 keyBase64
                  : (NSString *)keyBase64 targetPath
                  : (NSString *)targetPath sliceBytes
                  : (double)sliceBytes resolve
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(readTextSlice
                  : (NSString *)path start
                  : (double)start end
                  : (double)end resolve
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(sha256File
                  : (NSString *)sourcePath chunkSize
                  : (double)chunkSize resolve
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(buildUploadFrameBlob
                  : (NSString *)sourcePath offset
                  : (double)offset length
                  : (double)length uploadId
                  : (NSString *)uploadId seq
                  : (double)seq resolve
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)

// Vault v4 (LibrarySyncV4.swift): one op-stream page fetched, decrypted and inflated natively; the one-time packing
// of the playback database's chunk lists.
RCT_EXTERN_METHOD(fetchOpsPage
                  : (NSDictionary *)options resolve
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(convertChunkLists
                  : (NSString *)playbackDbPath nowIso
                  : (NSString *)nowIso resolve
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)

@end
