#import <React/RCTViewManager.h>

// Exposes the Swift `MpvPlayerViewManager` (MpvPlayerView.swift) as the "MpvPlayerView" native component.
@interface RCT_EXTERN_MODULE (MpvPlayerViewManager, RCTViewManager)

RCT_EXPORT_VIEW_PROPERTY(source, NSString)
RCT_EXPORT_VIEW_PROPERTY(startOptions, NSString)
RCT_EXPORT_VIEW_PROPERTY(onSurfaceTap, RCTDirectEventBlock)

@end
