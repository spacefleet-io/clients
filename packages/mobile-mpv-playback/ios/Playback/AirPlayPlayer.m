#import <TargetConditionals.h>
#if TARGET_OS_IOS
#import <React/RCTBridgeModule.h>

// Exposes the Swift `AirPlayPlayer` class (AirPlayPlayer.swift) to React Native. iPhone only.
@interface RCT_EXTERN_MODULE (AirPlayPlayer, NSObject)

RCT_EXTERN_METHOD(getRoute
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(load
                  : (NSString *)url startSeconds
                  : (double)startSeconds resolve
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(play
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(pause
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(seek
                  : (double)seconds resolve
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(stop
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(getState
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(setSubtitleIndex
                  : (NSInteger)index resolve
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)

@end
#endif
