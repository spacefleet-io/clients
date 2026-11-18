#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

@interface RCT_EXTERN_MODULE(MediaVolume, RCTEventEmitter)

RCT_EXTERN_METHOD(getMediaVolume : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(setMediaVolume : (double)level resolve : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject)

@end
