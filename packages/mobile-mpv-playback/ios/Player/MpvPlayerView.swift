import MediaProxy
import QuartzCore
import React
import UIKit

/// Native player surface (JS `<MpvPlayer/>`): a `CAMetalLayer` that an embedded libmpv core (`MpvEngine`) renders into
/// through MoltenVK. Same contract as the Android `MpvSurfaceView`: `source` (master.m3u8 URL), `startOptions` (mpv
/// per-file options, "start=12.5,aid=2") and the direct event `onSurfaceTap`. Props from one React batch arrive as
/// separate setter calls, so the load is applied on the next main-queue tick, when both are in place.
///
/// The metal layer is a plain sublayer, not the view's backing layer: MoltenVK sets `drawableSize` & co. from mpv's VO
/// thread, and UIKit forbids touching a view's own layer off the main thread. Its frame follows the view in
/// `layoutSubviews` (main thread); mpv observes the layer's bounds and resizes its swapchain.
final class MpvPlayerView: UIView {
  private let metalLayer = CAMetalLayer()
  private var engine: MpvEngine!
  private var loadedSource: String?
  private var applyScheduled = false

  @objc var onSurfaceTap: RCTDirectEventBlock?
  @objc var source: NSString? { didSet { scheduleApply() } }
  @objc var startOptions: NSString? { didSet { scheduleApply() } }

  override init(frame: CGRect) {
    super.init(frame: frame)
    backgroundColor = .black
    metalLayer.isOpaque = true
    metalLayer.backgroundColor = UIColor.black.cgColor
    // mpv sizes its swapchain from bounds × contentsScale: native pixels, not CALayer's default 1×.
    metalLayer.contentsScale = UIScreen.main.nativeScale
    metalLayer.frame = bounds
    layer.addSublayer(metalLayer)
    engine = MpvEngine(layer: metalLayer)
    let tap = UITapGestureRecognizer(target: self, action: #selector(handleTap(_:)))
    tap.cancelsTouchesInView = false
    addGestureRecognizer(tap)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

  deinit { engine.destroy() }

  override func layoutSubviews() {
    super.layoutSubviews()
    guard metalLayer.frame != bounds else { return }
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    metalLayer.frame = bounds
    CATransaction.commit()
    PlaybackLog.info("view.layout size=\(Int(bounds.width))x\(Int(bounds.height)) scale=\(metalLayer.contentsScale)")
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if let screen = window?.screen, metalLayer.contentsScale != screen.nativeScale {
      metalLayer.contentsScale = screen.nativeScale
    }
  }

  private func scheduleApply() {
    guard !applyScheduled else { return }
    applyScheduled = true
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      self.applyScheduled = false
      self.apply()
    }
  }

  private func apply() {
    guard let url = source as String?, !url.trimmingCharacters(in: .whitespaces).isEmpty, url != loadedSource else { return }
    loadedSource = url
    do {
      try engine.load(url: url, options: startOptions as String?)
    } catch {
      PlaybackLog.error("view.load_failed url=\(url) error=\(error)")
    }
  }

  @objc private func handleTap(_ g: UITapGestureRecognizer) {
    let p = g.location(in: self)
    let scale = metalLayer.contentsScale
    onSurfaceTap?([
      "x": p.x * scale, "y": p.y * scale,
      "surfaceWidth": bounds.width * scale, "surfaceHeight": bounds.height * scale,
    ])
  }
}

@objc(MpvPlayerViewManager)
final class MpvPlayerViewManager: RCTViewManager {
  override static func requiresMainQueueSetup() -> Bool { true }
  override func view() -> UIView! { MpvPlayerView() }
}
