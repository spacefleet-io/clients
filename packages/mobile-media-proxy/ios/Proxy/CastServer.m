#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

// Exposes the Swift `CastServer` class (CastServer.swift) to React Native.
@interface RCT_EXTERN_MODULE (CastServer, RCTEventEmitter)

RCT_EXTERN_METHOD(start
                  : (NSString *)metadataJson libraryKeyBase64
                  : (NSString *)libraryKeyBase64 config
                  : (NSDictionary *)config token
                  : (NSString *)token resolve
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(readText
                  : (NSString *)key resolve
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(putText
                  : (NSString *)key body
                  : (NSString *)body resolve
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(stop
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)

@end
