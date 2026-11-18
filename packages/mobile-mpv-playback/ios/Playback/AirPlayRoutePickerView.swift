#if os(iOS)
import AVKit
import React
import UIKit

/// Apple's AirPlay button (`AVRoutePickerView`) as the "AirPlayRoutePickerView" native component (UX-TV-03). Choosing a
/// device there makes it the audio/video output route; `AirPlayPlayer.load` then hands the cast stream to it.
final class AirPlayRoutePickerNativeView: UIView {
  private let picker = AVRoutePickerView()

  @objc var tintColorValue: UIColor? { didSet { picker.tintColor = tintColorValue ?? .label } }
  @objc var activeTintColorValue: UIColor? { didSet { picker.activeTintColor = activeTintColorValue } }
  @objc var prioritizesVideoDevices: Bool = true { didSet { picker.prioritizesVideoDevices = prioritizesVideoDevices } }

  override init(frame: CGRect) {
    super.init(frame: frame)
    picker.prioritizesVideoDevices = true
    picker.translatesAutoresizingMaskIntoConstraints = false
    addSubview(picker)
    NSLayoutConstraint.activate([
      picker.leadingAnchor.constraint(equalTo: leadingAnchor),
      picker.trailingAnchor.constraint(equalTo: trailingAnchor),
      picker.topAnchor.constraint(equalTo: topAnchor),
      picker.bottomAnchor.constraint(equalTo: bottomAnchor),
    ])
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }
}

@objc(AirPlayRoutePickerViewManager)
final class AirPlayRoutePickerViewManager: RCTViewManager {
  override static func requiresMainQueueSetup() -> Bool { true }
  override func view() -> UIView! { AirPlayRoutePickerNativeView() }
}
#endif
