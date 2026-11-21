#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

// Exposes the Swift `LibrarySync` class (LibrarySync.swift) to React Native.
@interface RCT_EXTERN_MODULE (LibrarySync, RCTEventEmitter)

RCT_EXTERN_METHOD(decryptBase64File
                  : (NSString *)sourcePath keyBase64
                  : (NSString *)keyBase64 outputPath
                  : (NSString *)outputPath resolve
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(decryptBinaryFile
                  : (NSString *)sourcePath keyBase64
                  : (NSString *)keyBase64 outputPath
                  : (NSString *)outputPath resolve
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(encryptBinaryFile
                  : (NSString *)sourcePath keyBase64
                  : (NSString *)keyBase64 outputPath
                  : (NSString *)outputPath resolve
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

@end
