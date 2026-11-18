require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

Pod::Spec.new do |s|
  s.name         = "SpaceMediaSession"
  s.version      = package["version"]
  s.summary      = "SpaceFleet phone apps: Now Playing and remote commands for the player (PLAY-OSMEDIA-01)"
  s.homepage     = "https://github.com/spacefleet-io/clients"
  s.license      = { :type => "GPL-3.0-only", :file => "LICENSE" }
  s.author       = "SpaceFleet"
  s.platforms    = { :ios => "15.1", :tvos => "15.1" }
  s.source       = { :git => "https://github.com/spacefleet-io/clients.git", :tag => "v#{s.version}" }
  s.source_files = "ios/**/*.{h,m,swift}"
  s.swift_version = "5.0"
  s.frameworks   = "AVFoundation", "MediaPlayer"
  s.pod_target_xcconfig = { "DEFINES_MODULE" => "YES" }

  if respond_to?(:install_modules_dependencies, true)
    install_modules_dependencies(s)
  else
    s.dependency "React-Core"
  end
end
