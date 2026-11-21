#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

// Exposes the Swift `PlaybackBridge` class (PlaybackBridge.swift) to React Native.
@interface RCT_EXTERN_MODULE (PlaybackBridge, RCTEventEmitter)

RCT_EXTERN_METHOD(startProxy
                  : (NSString *)metadataJson libraryKeyBase64
                  : (NSString *)libraryKeyBase64 config
                  : (NSDictionary *)config resolve
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(start
                  : (NSString *)libraryKeyBase64 config
                  : (NSDictionary *)config resolve
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(registerChunkedFile
                  : (NSString *)fileJson resolve
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(swapChunkedFile
                  : (NSString *)fileJson resolve
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(unregisterChunkedFile
                  : (NSString *)fileId resolve
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(setBufferCap
                  : (double)seconds resolve
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(setNeighbours
                  : (NSString *)current next
                  : (NSString *)next previous
                  : (NSString *)previous resolve
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(stopProxy
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)

@end
