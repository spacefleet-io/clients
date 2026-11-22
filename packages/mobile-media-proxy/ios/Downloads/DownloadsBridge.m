#include <TargetConditionals.h>
#if TARGET_OS_IOS
#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

// Exposes the Swift `DownloadsBridge` class (DownloadsBridge.swift) to React Native.
@interface RCT_EXTERN_MODULE (DownloadsBridge, RCTEventEmitter)

RCT_EXTERN_METHOD(configure
                  : (NSString *)authToken appId
                  : (NSString *)appId wifiOnly
                  : (BOOL)wifiOnly labelsJson
                  : (NSString *)labelsJson resolve
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(enqueue
                  : (NSString *)itemJson resolve
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(retry
                  : (NSString *)itemId gatewayCandidatesJson
                  : (NSString *)gatewayCandidatesJson resolve
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(remove
                  : (NSString *)idsJson resolve
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(removeAll : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(listItems : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(resume : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(getState : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(getStatus : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject)

@end
#endif
