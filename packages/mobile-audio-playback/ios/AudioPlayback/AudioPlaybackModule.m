#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

// Exposes the Swift `AudioPlaybackModule` class, `@objc(AudioPlayback)` (AudioPlaybackModule.swift), to React Native as
// `NativeModules.AudioPlayback`: the same methods as Android's AudioPlaybackModule.kt (src/index.ts).
@interface RCT_EXTERN_MODULE (AudioPlayback, RCTEventEmitter)

RCT_EXTERN_METHOD(setQueue : (NSString *)itemsJson startIndex : (double)startIndex startPositionMs : (double)
                      startPositionMs resolve : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(addItems : (NSString *)itemsJson where : (NSString *)where resolve : (RCTPromiseResolveBlock)
                      resolve reject : (RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(play : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(pause : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(next : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(previous : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(seekTo : (double)positionMs resolve : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)
                      reject)
RCT_EXTERN_METHOD(getState : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(getUpNext : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(stop : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(setShuffle : (BOOL)enabled resolve : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)
                      reject)
RCT_EXTERN_METHOD(setGains : (NSString *)gainsJson resolve : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)
                      reject)
RCT_EXTERN_METHOD(setLimiting : (BOOL)on resolve : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(setRepeatMode : (NSString *)mode resolve : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)
                      reject)
RCT_EXTERN_METHOD(canShowOutputSwitcher : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(showOutputSwitcher : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(setKeepScreenOn : (BOOL)enabled resolve : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)
                      reject)

@end
