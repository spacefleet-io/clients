require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

# The local playback proxy shared by Badger (phone + Apple TV) and Parrot (phone): the iOS twin of this package's
# Android library. ios/Proxy is the loopback/cast HTTP server, the storage tunnel client and the `PlaybackBridge` RN
# module (HLS sessions for mpv, chunked files for Parrot's audio player); ios/Downloads is the background download
# engine and its `DownloadsBridge` RN module, phone only (a TV has no downloads). No player code: the mpv pod
# (packages/mobile-mpv-playback) depends on this one and plugs its player in through `MediaProxyHooks`.
Pod::Spec.new do |s|
  s.name         = "MediaProxy"
  s.version      = package["version"]
  s.summary      = "SpaceFleet local playback proxy (HLS + chunked files over an encrypted storage tunnel) and offline downloads"
  s.homepage     = "https://github.com/spacefleet-io/clients"
  s.license      = { :type => "GPL-3.0-only", :file => "LICENSE" }
  s.author       = "SpaceFleet"
  s.platforms    = { :ios => "15.1", :tvos => "15.1" }
  s.source       = { :git => "https://github.com/spacefleet-io/clients.git", :tag => "v#{s.version}" }

  s.source_files = "ios/Proxy/**/*.{h,m,swift}"
  s.ios.source_files = "ios/Downloads/**/*.{h,m,swift}"
  # Download notification texts (UX-I18N-02), looked up by `DownloadNotifications` in this bundle.
  s.ios.resource_bundles = { "MediaProxyDownloads" => ["ios/Downloads/Resources/*.lproj/*.strings"] }
  s.swift_version = "5.0"
  s.frameworks   = "CryptoKit", "Network"
  s.ios.frameworks = "UserNotifications"

  s.pod_target_xcconfig = {
    "DEFINES_MODULE" => "YES",
    "SWIFT_ENABLE_EXPLICIT_MODULES" => "NO",
  }

  if respond_to?(:install_modules_dependencies, true)
    install_modules_dependencies(s)
  else
    s.dependency "React-Core"
  end
end
