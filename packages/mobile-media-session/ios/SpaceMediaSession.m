#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

// Exposes the Swift `SpaceMediaSession` class (SpaceMediaSession.swift) to React Native.
@interface RCT_EXTERN_MODULE (SpaceMediaSession, RCTEventEmitter)

RCT_EXTERN_METHOD(update : (NSDictionary *)plan)
// JS calls it `release`; the native selector cannot be NSObject's `release`.
_RCT_EXTERN_REMAP_METHOD(release, releaseSession, NO)

@end
