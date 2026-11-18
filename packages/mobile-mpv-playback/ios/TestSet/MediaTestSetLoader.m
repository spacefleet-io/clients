// Debug / test-build-only (SB_MEDIA_TEST_SET=YES on xcodebuild, or the Debug configuration): starts the media format
// test set runner (MediaTestSetRunner.swift, REL-DEPS-11) when the app is launched with SB_MEDIA_TEST_SET=1. A plain
// Release build compiles neither file, like Android's src/debug MediaTestSetActivity.
#if DEBUG || SB_MEDIA_TEST_SET
#import <Foundation/Foundation.h>

@interface NSObject (SBMediaTestSetRunner)
+ (void)installIfRequested;
@end

@interface SBMediaTestSetLoader : NSObject
@end

@implementation SBMediaTestSetLoader
+ (void)load {
  Class runner = NSClassFromString(@"SBMediaTestSetRunner");
  if ([runner respondsToSelector:@selector(installIfRequested)]) {
    [runner installIfRequested];
  } else {
    NSLog(@"MediaTestSet: SBMediaTestSetRunner missing, runner not installed");
  }
}
@end
#endif
