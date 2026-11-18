#import <TargetConditionals.h>
#if TARGET_OS_IOS
#import <React/RCTViewManager.h>

// Exposes the Swift `AirPlayRoutePickerViewManager` (AirPlayRoutePickerView.swift) as the "AirPlayRoutePickerView" component.
@interface RCT_EXTERN_MODULE (AirPlayRoutePickerViewManager, RCTViewManager)

RCT_REMAP_VIEW_PROPERTY(tintColor, tintColorValue, UIColor)
RCT_REMAP_VIEW_PROPERTY(activeTintColor, activeTintColorValue, UIColor)
RCT_EXPORT_VIEW_PROPERTY(prioritizesVideoDevices, BOOL)

@end
#endif
