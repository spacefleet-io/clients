require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

Pod::Spec.new do |s|
  s.name         = "AudioPlayback"
  s.version      = package["version"]
  s.summary      = "Parrot's in-app music player on the iPhone and Apple TV: AVQueuePlayer, even volume, lock screen (PAR-PLAY-01, PAR-TV-11)"
  s.homepage     = "https://github.com/spacefleet-io/clients"
  s.license      = { :type => "GPL-3.0-only", :file => "LICENSE" }
  s.author       = "SpaceFleet"
  s.platforms    = { :ios => "15.1", :tvos => "15.1" }
  s.source       = { :git => "https://github.com/spacefleet-io/clients.git", :tag => "v#{s.version}" }

  # ios/AudioPlayback/Core holds the pure logic (limiter, gains, queue order) that the app's unit-test target compiles
  # together with ios/Tests; the tests themselves never go into the pod.
  s.source_files = "ios/AudioPlayback/**/*.{h,m,swift}"
  s.exclude_files = "ios/Tests/**/*"
  s.swift_version = "5.0"
  s.frameworks   = "AVFoundation", "AVKit", "MediaPlayer", "MediaToolbox", "CoreMedia", "UIKit"

  s.pod_target_xcconfig = {
    "DEFINES_MODULE" => "YES",
  }

  if respond_to?(:install_modules_dependencies, true)
    install_modules_dependencies(s)
  else
    s.dependency "React-Core"
  end
end
