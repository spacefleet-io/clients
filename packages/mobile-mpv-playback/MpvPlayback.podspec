require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

# libmpv, FFmpeg and MoltenVK as dynamic xcframeworks (media-deps targets `ios-arm64` / `tvos-arm64` and their
# `-simulator` twins, our LGPL build), embedded and signed into the app by CocoaPods. scripts/fetch-ios-deps.ts
# [--target tvos-arm64] joins each platform's device and simulator slices into ios/vendor/media-deps/<ios|tvos>, so
# Xcode picks the device slice for a device build and the simulator slice for a simulator build (REL-MOB-02,
# REL-TV-03). The iPhone app's Podfile runs it for ios-arm64; the Apple TV app for tvos-arm64.
vendored_deps = "ios/vendor/media-deps"
unless %w[ios tvos].any? { |platform| Dir.exist?(File.join(__dir__, vendored_deps, platform, "Libmpv.xcframework")) }
  raise "MpvPlayback: #{vendored_deps} is empty. Run `bun packages/mobile-mpv-playback/scripts/fetch-ios-deps.ts " \
        "[--target tvos-arm64]` (add `--local` / `--local-simulator` to use packages/media-deps/out/<target>)."
end

Pod::Spec.new do |s|
  s.name         = "MpvPlayback"
  s.version      = package["version"]
  s.summary      = "SpaceBadger playback: embedded libmpv player (and AirPlay) for iOS and tvOS, over the MediaProxy pod's local proxy"
  s.homepage     = "https://github.com/spacefleet-io/clients"
  s.license      = { :type => "GPL-3.0-only", :file => "LICENSE" }
  s.author       = "SpaceFleet"
  # tvOS = react-native-tvos 0.85's floor, same as iOS (media-deps recipes/_apple-mobile/appleMobileTarget.ts).
  s.platforms    = { :ios => "15.1", :tvos => "15.1" }
  s.source       = { :git => "https://github.com/spacefleet-io/clients.git", :tag => "v#{s.version}" }

  # Not `ios/**`: the vendored frameworks carry headers of their own (and `exclude_files` would drop the frameworks too).
  # ios/TestSet is the media format test set runner (REL-DEPS-11): its sources compile to nothing unless the build is
  # Debug or passes SB_MEDIA_TEST_SET=YES (packages/media-deps/scripts/run-media-test-set-ios.ts), like Android's
  # src/debug runner, so a plain Release build never contains it.
  s.source_files = "ios/{Player,Playback,TestSet}/**/*.{h,m,swift}"
  s.ios.vendored_frameworks = "#{vendored_deps}/ios/*.xcframework"
  s.tvos.vendored_frameworks = "#{vendored_deps}/tvos/*.xcframework"
  s.swift_version = "5.0"
  s.frameworks   = "AVFoundation", "AVKit", "CoreMedia", "Metal", "Network", "QuartzCore", "VideoToolbox"

  # The simulator bundles are arm64 only (Apple silicon Macs): a Release or generic simulator build would also build
  # x86_64, find no slice for it and fail on `import Libmpv`. The app target links these frameworks too, hence user_.
  simulator_archs = {
    "EXCLUDED_ARCHS[sdk=iphonesimulator*]" => "x86_64",
    "EXCLUDED_ARCHS[sdk=appletvsimulator*]" => "x86_64",
  }
  s.pod_target_xcconfig = {
    "DEFINES_MODULE" => "YES",
    "SWIFT_ENABLE_EXPLICIT_MODULES" => "NO",
    # SB_MEDIA_TEST_SET=YES (an xcodebuild command-line setting, so it reaches this pod target) → compile ios/TestSet.
    "SB_MEDIA_TEST_SET_SWIFT_YES" => "SB_MEDIA_TEST_SET",
    "SB_MEDIA_TEST_SET_CLANG_YES" => "SB_MEDIA_TEST_SET=1",
    "SWIFT_ACTIVE_COMPILATION_CONDITIONS" => "$(inherited) $(SB_MEDIA_TEST_SET_SWIFT_$(SB_MEDIA_TEST_SET))",
    "GCC_PREPROCESSOR_DEFINITIONS" => "$(inherited) $(SB_MEDIA_TEST_SET_CLANG_$(SB_MEDIA_TEST_SET))",
  }.merge(simulator_archs)
  s.user_target_xcconfig = simulator_archs

  # The playback proxy (PlaybackBridge, PlaybackHttpServer, PlaybackLog, TrafficBuffer, NetworkMeter, MediaProxyHooks)
  # lives in the MediaProxy pod (packages/mobile-media-proxy), shared with Parrot; this pod is the player.
  s.dependency "MediaProxy"

  if respond_to?(:install_modules_dependencies, true)
    install_modules_dependencies(s)
  else
    s.dependency "React-Core"
  end
end
