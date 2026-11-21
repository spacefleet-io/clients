import AVFoundation
import MediaPlayer
import UIKit

/// One queue entry as JS sent it (`AudioQueueItem` in `src/index.ts`); `uid` tells two entries of the same song apart.
struct AudioQueueEntry {
  let uid: Int
  let id: String
  let url: URL
  let mimeType: String?
  let title: String
  let artist: String?
  let album: String?
  let artworkUri: URL?
  let key: String?
}

/// The iPhone's music player (PAR-PLAY-01), the counterpart of Android's Media3 `AudioPlaybackService`: an
/// `AVQueuePlayer` holding the song playing and the one that plays after it, so one runs into the next with no gap
/// (PAR-PLAY-03 item 1); each item carries its even-volume tap (`AudioTap`). The queue, its order, shuffle and repeat
/// live in the pure `PlayQueue`, which follows Media3's rules. The audio session is `.playback`, so the music goes on
/// in the background and with the screen locked; the lock screen and headset reach it through
/// `MPNowPlayingInfoCenter` and `MPRemoteCommandCenter` (PAR-PLAY-03 item 3, PLAY-OSMEDIA-01); calls and unplugged
/// headphones follow PLAY-FOCUS-01.
///
/// Main thread only. JS hears every change through `onState` (the `AudioPlaybackState` event).
final class AudioPlayer: NSObject {
  static let shared = AudioPlayer()

  /// Receives every state change (the shape of `AudioPlaybackState`).
  var onState: (([String: Any]) -> Void)?

  private var player = AVQueuePlayer()
  private var playerObservations: [NSKeyValueObservation] = []
  /// Calls `syncUpcoming` every second while playing, so the upcoming item is made once the playing song is loaded far enough.
  private var upcomingTicker: Any?
  private var queue = PlayQueue<AudioQueueEntry>()
  private var random = SystemRandomNumberGenerator()
  private var nextUid = 0

  private var playWhenReady = false
  /// A call, an alarm or Siri holds the music back (PLAY-FOCUS-01 item 2): no sound, `playWhenReady` stays.
  private var suppressed = false
  private var ended = false
  private var endedPositionMs = 0.0
  private var errorName: String?

  /// Bumped on every jump (new queue, Next, Previous, a seek past the end): loads started before it are dropped.
  private var generation = 0
  /// The AVPlayerItem of `queue.current` (nil while it loads).
  private var currentItem: AVPlayerItem?
  /// The item queued after it in the `AVQueuePlayer` for the gapless step, and the entry it plays.
  private var upcoming: (uid: Int, item: AVPlayerItem)?
  /// The entry whose upcoming item is loading.
  private var upcomingLoading: Int?
  /// An upcoming entry that could not be loaded, with its error: it fails when its turn comes, as on Android.
  private var upcomingFailure: (uid: Int, error: String)?
  /// The upcoming entry waiting for the playing song to load far enough (`UpcomingGate`), so the wait logs once.
  private var upcomingWaiting: Int?
  private var itemObservations: [ObjectIdentifier: [NSKeyValueObservation]] = [:]
  private var lastSignature: [String: AnyHashable]?
  private var setUp = false
  private var artwork: (url: URL, artwork: MPMediaItemArtwork)?

  /// REL-ENV-36: with `SF_SILENT=1` in the environment (the UI tests' launch environment) the player makes no sound
  /// and everything else runs as normal: positions advance, states go out, the lock screen card updates.
  static let silent = ProcessInfo.processInfo.environment["SF_SILENT"] == "1"

  private override init() {
    super.init()
    if Self.silent { AudioLog.info("[AudioPlayback] silent: SF_SILENT=1 output volume 0") }
    applyVolume()
  }

  private func applyVolume() {
    player.volume = Self.silent ? 0 : 1
  }

  private static func orNull(_ value: String?) -> Any {
    if let value { return value }
    return NSNull()
  }

  // MARK: - Commands (the JS API)

  /// Replaces the queue with `entries` and plays `entries[start]` from `positionMs` (Media3 setMediaItems + prepare +
  /// play).
  func setQueue(_ items: [[String: Any]], start: Int, positionMs: Double) {
    setUpOnce()
    let entries = items.compactMap(entry(from:))
    queue.set(entries, start: start, using: &random)
    AudioLog.info(
      "audio.queue.set n=\(entries.count) start=\(queue.current) position_ms=\(Int(positionMs)) "
        + "shuffle=\(queue.shuffle) repeat=\(queue.repeatMode.rawValue) dropped=\(items.count - entries.count)")
    playWhenReady = true
    if queue.isEmpty {
      tearDownItems()
      ended = true
      emit(force: true)
      return
    }
    jump(to: queue.current, positionMs: positionMs)
  }

  /// Adds songs without stopping the one playing: "next" right after it, "end" after the last one, also with shuffle
  /// on. An empty queue starts playing them.
  func addItems(_ items: [[String: Any]], where position: String) {
    setUpOnce()
    let entries = items.compactMap(entry(from:))
    let started = queue.add(entries, atEnd: position != "next", using: &random)
    AudioLog.info("audio.queue.add n=\(entries.count) where=\(position) count=\(queue.count) started=\(started)")
    if started {
      playWhenReady = true
      jump(to: queue.current, positionMs: 0)
    } else {
      syncUpcoming()
      emit()
    }
  }

  /// Media3's play button: from the end of the queue it starts the current song again, after an error it loads it
  /// again, after a call it takes the sound back.
  func play() {
    setUpOnce()
    playWhenReady = true
    AudioLog.info("audio.cmd.play ended=\(ended) error=\(errorName ?? "-") suppressed=\(suppressed)")
    guard !queue.isEmpty else {
      emit()
      return
    }
    if ended {
      jump(to: queue.current, positionMs: 0)
      return
    }
    if errorName != nil {
      jump(to: queue.current, positionMs: positionMs)
      return
    }
    if activateSession() { suppressed = false }
    if currentItem != nil { player.play() }
    emit()
  }

  func pause() {
    playWhenReady = false
    player.pause()
    AudioLog.info("audio.cmd.pause position_ms=\(Int(positionMs))")
    emit()
  }

  func next() {
    let index = queue.nextForNavigation
    AudioLog.info("audio.cmd.next from=\(queue.current) to=\(index)")
    guard index >= 0 else { return emit() }
    jump(to: index, positionMs: 0)
  }

  /// Restarts the song past its first 3 seconds, else goes to the previous one (Media3's `seekToPrevious`).
  func previous() {
    let action = queue.previousAction(positionMs: Int64(positionMs))
    AudioLog.info("audio.cmd.previous from=\(queue.current) position_ms=\(Int(positionMs)) action=\(action)")
    switch action {
    case .item(let index): jump(to: index, positionMs: 0)
    case .restart: seek(to: 0)
    }
  }

  func seek(to positionMs: Double) {
    AudioLog.info("audio.cmd.seek position_ms=\(Int(positionMs)) ended=\(ended)")
    guard !queue.isEmpty else { return emit() }
    guard let item = currentItem, !ended, errorName == nil else {
      jump(to: queue.current, positionMs: positionMs)
      return
    }
    AudioTap.processor.flush()
    let time = CMTime(value: CMTimeValue(max(0, positionMs)), timescale: 1000)
    item.seek(to: time, toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] finished in
      DispatchQueue.main.async {
        AudioLog.debug("audio.seek.done position_ms=\(Int(positionMs)) finished=\(finished)")
        self?.emit(force: true)
      }
    }
    emit(force: true)
  }

  /// Clears the queue and gives the sound back (sign out).
  func stop() {
    AudioLog.info("audio.cmd.stop count=\(queue.count)")
    generation += 1
    tearDownItems()
    queue.clear()
    ended = false
    errorName = nil
    suppressed = false
    deactivateSession()
    MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
    emit(force: true)
  }

  func setShuffle(_ enabled: Bool) {
    queue.setShuffle(enabled, using: &random)
    AudioLog.info("audio.cmd.shuffle on=\(enabled) order=\(queue.shuffle ? queue.order.order.description : "-")")
    syncUpcoming()
    emit()
  }

  func setRepeatMode(_ mode: String) {
    queue.repeatMode = RepeatMode(rawValue: mode) ?? .off
    AudioLog.info("audio.cmd.repeat mode=\(queue.repeatMode.rawValue)")
    syncUpcoming()
    emit()
  }

  /// The media ids that play after the current song, in play order (shuffle, repeat all wrapping once).
  func upNext() -> [String] { queue.upNext.map { queue.items[$0].id } }

  // MARK: - State

  private var positionMs: Double {
    if ended { return endedPositionMs }
    guard let item = currentItem else { return 0 }
    return Self.milliseconds(item.currentTime()) ?? 0
  }

  private var durationMs: Double {
    guard let item = currentItem else { return -1 }
    return Self.milliseconds(item.duration) ?? -1
  }

  private static func milliseconds(_ time: CMTime) -> Double? {
    guard time.isNumeric, time.isValid, !time.isIndefinite else { return nil }
    let seconds = time.seconds
    return seconds.isFinite ? (seconds * 1000).rounded() : nil
  }

  private var stateName: String {
    if ended { return "ended" }
    if queue.isEmpty || errorName != nil { return "idle" }
    guard let item = currentItem, item.status == .readyToPlay else { return "buffering" }
    if player.timeControlStatus == .waitingToPlayAtSpecifiedRate { return "buffering" }
    return "ready"
  }

  private var isPlaying: Bool {
    !ended && errorName == nil && currentItem != nil && player.timeControlStatus == .playing
  }

  /// The `AudioPlaybackState` of now.
  func snapshot() -> [String: Any] {
    let entry = queue.currentItem
    let next = queue.nextForNavigation
    let nextKey = next >= 0 ? queue.items[next].key : nil
    let previous = queue.previousForNavigation
    let previousKey = previous >= 0 ? queue.items[previous].key : nil
    return [
      "state": stateName,
      "playing": isPlaying,
      "playWhenReady": playWhenReady,
      "suppressed": suppressed,
      "positionMs": positionMs,
      "durationMs": durationMs,
      // Media3 reports index 0 for an empty queue.
      "index": max(0, queue.current),
      "count": queue.count,
      "key": Self.orNull(entry?.key),
      "nextKey": Self.orNull(nextKey),
      "previousKey": Self.orNull(previousKey),
      "mediaId": Self.orNull(entry?.id),
      "error": Self.orNull(errorName),
      "shuffle": queue.shuffle,
      "repeat": queue.repeatMode.rawValue,
    ]
  }

  /// Sends the state to JS when anything but the position changed (Media3's `onEvents`), or always with `force`
  /// (a seek, a jump), and refreshes the lock screen.
  private func emit(force: Bool = false) {
    let state = snapshot()
    var signature: [String: AnyHashable] = [:]
    for (key, value) in state where key != "positionMs" {
      signature[key] = (value as? AnyHashable) ?? ("null" as AnyHashable)
    }
    updateNowPlaying()
    guard force || signature != lastSignature else { return }
    lastSignature = signature
    AudioLog.info(
      "audio.state state=\(state["state"]!) playing=\(state["playing"]!) play_when_ready=\(playWhenReady) "
        + "suppressed=\(suppressed) position_ms=\(Int(positionMs)) duration_ms=\(Int(durationMs)) "
        + "index=\(state["index"]!) count=\(queue.count) media=\(queue.currentItem?.id ?? "-") "
        + "key=\(queue.currentItem?.key ?? "-") error=\(errorName ?? "-") shuffle=\(queue.shuffle) "
        + "repeat=\(queue.repeatMode.rawValue)")
    onState?(state)
  }

  // MARK: - Items

  private func entry(from item: [String: Any]) -> AudioQueueEntry? {
    guard let id = item["id"] as? String, let urlString = item["url"] as? String, let url = URL(string: urlString) else {
      AudioLog.error("audio.queue.bad_item keys=\(item.keys.sorted())")
      return nil
    }
    if let gain = item["gainDb"] as? NSNumber { EvenVolume.shared.setGainDb(id, gain.floatValue) }
    nextUid += 1
    let nonEmpty = { (key: String) -> String? in
      guard let value = item[key] as? String, !value.isEmpty else { return nil }
      return value
    }
    return AudioQueueEntry(
      uid: nextUid,
      id: id,
      url: url,
      mimeType: nonEmpty("mimeType"),
      title: (item["title"] as? String) ?? "",
      artist: nonEmpty("artist"),
      album: nonEmpty("album"),
      artworkUri: nonEmpty("artworkUri").flatMap(URL.init(string:)),
      key: nonEmpty("key"))
  }

  /// Loads `entry` into a player item carrying its even-volume tap. The tracks are read first, so the tap is on the
  /// item before its first sample plays; a file AVFoundation cannot play fails here with a Media3-style error name.
  private func makeItem(_ entry: AudioQueueEntry, completion: @escaping (Result<AVPlayerItem, ItemError>) -> Void) {
    var options: [String: Any] = [:]
    if let mimeType = entry.mimeType, #available(iOS 17.0, tvOS 17.0, *) {
      // Proxy URLs have no extension; the type otherwise comes from the response's Content-Type.
      options[AVURLAssetOverrideMIMETypeKey] = mimeType
    }
    let asset = AVURLAsset(url: entry.url, options: options)
    let started = Date()
    AudioLog.debug("audio.item.load media=\(entry.id) uid=\(entry.uid) mime=\(entry.mimeType ?? "-")")
    Task { @MainActor in
      do {
        let (playable, _) = try await asset.load(.isPlayable, .duration)
        let tracks = try await asset.loadTracks(withMediaType: .audio)
        let ms = Int(Date().timeIntervalSince(started) * 1000)
        guard playable, let track = tracks.first else {
          AudioLog.error(
            "audio.error code=ERROR_CODE_DECODING_FORMAT_UNSUPPORTED media=\(entry.id) playable=\(playable) "
              + "audio_tracks=\(tracks.count) load_ms=\(ms)")
          completion(.failure(ItemError(name: "ERROR_CODE_DECODING_FORMAT_UNSUPPORTED")))
          return
        }
        let item = AVPlayerItem(asset: asset)
        item.audioMix = AudioTap.mix(track: track, mediaId: entry.id)
        AudioLog.info("audio.item.ready media=\(entry.id) uid=\(entry.uid) load_ms=\(ms) tap=\(item.audioMix != nil)")
        completion(.success(item))
      } catch {
        let name = Self.errorName(error)
        AudioLog.error("audio.error code=\(name) media=\(entry.id) \(Self.describe(error))")
        completion(.failure(ItemError(name: name)))
      }
    }
  }

  struct ItemError: Error {
    let name: String
  }

  /// Plays `queue.items[index]` from `positionMs`: a new player item (the old ones go), then the next one behind it.
  private func jump(to index: Int, positionMs: Double) {
    generation += 1
    let token = generation
    AudioTap.processor.flush()
    tearDownItems()
    queue.move(to: index)
    ended = false
    errorName = nil
    guard let entry = queue.currentItem else { return emit(force: true) }
    AudioLog.info("audio.jump index=\(index) media=\(entry.id) key=\(entry.key ?? "-") position_ms=\(Int(positionMs))")
    emit(force: true)
    makeItem(entry) { [weak self] result in
      guard let self, token == self.generation else { return }
      switch result {
      case .failure(let error):
        self.errorName = error.name
        self.emit(force: true)
      case .success(let item):
        self.currentItem = item
        self.observe(item)
        self.player.insert(item, after: nil)
        if positionMs > 0 {
          item.seek(to: CMTime(value: CMTimeValue(positionMs), timescale: 1000), toleranceBefore: .zero, toleranceAfter: .zero) {
            _ in DispatchQueue.main.async { self.emit(force: true) }
          }
        }
        if self.playWhenReady && !self.suppressed {
          _ = self.activateSession()
          self.player.play()
        }
        self.syncUpcoming()
        self.emit(force: true)
      }
    }
  }

  /// Keeps the `AVQueuePlayer`'s second item on the entry that plays when the current song ends (shuffle, repeat), so
  /// the step is gapless; called after every change of order, repeat or queue, and every second while playing. The
  /// item is made only once the playing song is loaded far enough ahead (`UpcomingGate`, PAR-PLAY-07): making it opens
  /// its stream, which must not take the connection from the playing song.
  private func syncUpcoming() {
    guard let current = currentItem, !ended, errorName == nil else { return }
    let next = queue.nextWhenEnded
    let desired = next >= 0 ? queue.items[next] : nil
    if let upcoming, upcoming.uid == desired?.uid { return }
    if upcomingLoading != nil, upcomingLoading == desired?.uid { return }
    // A failed upcoming entry fails when its turn comes (`itemEnded`); the every-second call does not load it again.
    if let failure = upcomingFailure, failure.uid == desired?.uid { return }
    if let upcoming {
      AudioLog.info("audio.upcoming.drop uid=\(upcoming.uid)")
      player.remove(upcoming.item)
      forget(upcoming.item)
      self.upcoming = nil
    }
    upcomingFailure = nil
    guard let desired else {
      upcomingLoading = nil
      return
    }
    let ranges = current.loadedTimeRanges.map { range -> (start: Double, end: Double) in
      let r = range.timeRangeValue
      return (r.start.seconds, r.end.seconds)
    }
    let position = current.currentTime().seconds
    guard UpcomingGate.ready(ranges: ranges, positionSeconds: position, durationSeconds: current.duration.seconds) else {
      upcomingLoading = nil
      if upcomingWaiting != desired.uid {
        upcomingWaiting = desired.uid
        AudioLog.info(
          "audio.upcoming.wait uid=\(desired.uid) position_s=\(String(format: "%.1f", position)) "
            + "loaded_end_s=\(String(format: "%.1f", ranges.map(\.end).max() ?? 0))")
      }
      return
    }
    upcomingWaiting = nil
    upcomingLoading = desired.uid
    let token = generation
    makeItem(desired) { [weak self] result in
      guard let self, token == self.generation, self.upcomingLoading == desired.uid else { return }
      self.upcomingLoading = nil
      switch result {
      case .failure(let error):
        self.upcomingFailure = (desired.uid, error.name)
      case .success(let item):
        guard self.currentItem === current, self.player.items().contains(current),
              self.player.canInsert(item, after: current) else {
          AudioLog.warn("audio.upcoming.late uid=\(desired.uid)")
          return
        }
        self.player.insert(item, after: current)
        self.observe(item)
        self.upcoming = (desired.uid, item)
        AudioLog.info("audio.upcoming.queued media=\(desired.id) uid=\(desired.uid) key=\(desired.key ?? "-")")
      }
    }
  }

  private func tearDownItems() {
    player.removeAllItems()
    for item in [currentItem, upcoming?.item].compactMap({ $0 }) { forget(item) }
    currentItem = nil
    upcoming = nil
    upcomingLoading = nil
    upcomingFailure = nil
    upcomingWaiting = nil
  }

  private func observe(_ item: AVPlayerItem) {
    itemObservations[ObjectIdentifier(item)] = [
      item.observe(\.status, options: [.new]) { [weak self] item, _ in
        DispatchQueue.main.async { self?.itemStatusChanged(item) }
      },
      item.observe(\.duration, options: [.new]) { [weak self] _, _ in
        DispatchQueue.main.async { self?.emit() }
      },
    ]
    let center = NotificationCenter.default
    center.addObserver(self, selector: #selector(itemEnded(_:)), name: .AVPlayerItemDidPlayToEndTime, object: item)
    center.addObserver(self, selector: #selector(itemFailed(_:)), name: .AVPlayerItemFailedToPlayToEndTime, object: item)
    center.addObserver(self, selector: #selector(itemStalled(_:)), name: .AVPlayerItemPlaybackStalled, object: item)
  }

  private func forget(_ item: AVPlayerItem) {
    itemObservations[ObjectIdentifier(item)] = nil
    let center = NotificationCenter.default
    center.removeObserver(self, name: .AVPlayerItemDidPlayToEndTime, object: item)
    center.removeObserver(self, name: .AVPlayerItemFailedToPlayToEndTime, object: item)
    center.removeObserver(self, name: .AVPlayerItemPlaybackStalled, object: item)
  }

  private func itemStatusChanged(_ item: AVPlayerItem) {
    guard item.status == .failed else { return emit() }
    let error = item.error
    let name = error.map(Self.errorName) ?? "ERROR_CODE_UNSPECIFIED"
    AudioLog.error("audio.error code=\(name) where=status \(error.map(Self.describe) ?? "-")")
    fail(item, name)
  }

  /// A failure of the current item stops the player with the error; one of the upcoming item fails when its turn comes.
  private func fail(_ item: AVPlayerItem, _ name: String) {
    if item === currentItem {
      errorName = name
      player.pause()
      emit(force: true)
    } else if let upcoming, item === upcoming.item {
      player.remove(item)
      forget(item)
      upcomingFailure = (upcoming.uid, name)
      self.upcoming = nil
    }
  }

  @objc private func itemEnded(_ notification: Notification) {
    DispatchQueue.main.async { [self] in
      guard let item = notification.object as? AVPlayerItem, item === currentItem else { return }
      // The upcoming item takes over by itself (currentItem KVO); only an end with nothing queued is handled here.
      guard upcoming == nil else { return }
      let next = queue.nextWhenEnded
      AudioLog.info("audio.item.ended media=\(queue.currentItem?.id ?? "-") next=\(next)")
      if next < 0 {
        endedPositionMs = durationMs >= 0 ? durationMs : positionMs
        ended = true
        emit(force: true)
        return
      }
      if let failure = upcomingFailure, failure.uid == queue.items[next].uid {
        generation += 1
        tearDownItems()
        queue.move(to: next)
        errorName = failure.error
        emit(force: true)
        return
      }
      // The next song was not loaded in time: it starts now, with a gap.
      AudioLog.warn("audio.upcoming.missed next=\(next)")
      jump(to: next, positionMs: 0)
    }
  }

  @objc private func itemFailed(_ notification: Notification) {
    DispatchQueue.main.async { [self] in
      guard let item = notification.object as? AVPlayerItem else { return }
      let error = notification.userInfo?[AVPlayerItemFailedToPlayToEndTimeErrorKey] as? Error
      let name = error.map(Self.errorName) ?? "ERROR_CODE_UNSPECIFIED"
      AudioLog.error("audio.error code=\(name) where=play_to_end \(error.map(Self.describe) ?? "-")")
      fail(item, name)
    }
  }

  @objc private func itemStalled(_ notification: Notification) {
    DispatchQueue.main.async { [self] in
      AudioLog.warn("audio.stalled media=\(queue.currentItem?.id ?? "-") position_ms=\(Int(positionMs))")
      emit()
    }
  }

  /// The `AVQueuePlayer` moved to the next item by itself (the gapless step).
  private func playerItemChanged() {
    guard let item = player.currentItem, item !== currentItem else { return }
    guard let upcoming, item === upcoming.item else {
      AudioLog.warn("audio.item.unexpected_current")
      return
    }
    if let previous = currentItem { forget(previous) }
    currentItem = item
    self.upcoming = nil
    if let index = queue.items.firstIndex(where: { $0.uid == upcoming.uid }) { queue.move(to: index) }
    AudioLog.info("audio.advance index=\(queue.current) media=\(queue.currentItem?.id ?? "-") key=\(queue.currentItem?.key ?? "-")")
    syncUpcoming()
    emit(force: true)
  }

  // MARK: - Setup: player, audio session, lock screen

  private func setUpOnce() {
    guard !setUp else { return }
    setUp = true
    observePlayer()
    let session = AVAudioSession.sharedInstance()
    do {
      try session.setCategory(.playback, mode: .default)
      AudioLog.info("audio.session.category category=playback")
    } catch {
      AudioLog.error("audio.session.category_failed \(Self.describe(error))")
    }
    let center = NotificationCenter.default
    center.addObserver(
      self, selector: #selector(interruption(_:)), name: AVAudioSession.interruptionNotification, object: session)
    center.addObserver(
      self, selector: #selector(routeChange(_:)), name: AVAudioSession.routeChangeNotification, object: session)
    center.addObserver(
      self, selector: #selector(mediaServicesReset(_:)), name: AVAudioSession.mediaServicesWereResetNotification,
      object: session)
    setUpRemoteCommands()
  }

  private func observePlayer() {
    player.actionAtItemEnd = .advance
    upcomingTicker = player.addPeriodicTimeObserver(forInterval: CMTime(value: 1, timescale: 1), queue: .main) { [weak self] _ in
      self?.syncUpcoming()
    }
    playerObservations = [
      player.observe(\.timeControlStatus, options: [.new]) { [weak self] _, _ in
        DispatchQueue.main.async { self?.emit() }
      },
      player.observe(\.currentItem, options: [.new]) { [weak self] _, _ in
        DispatchQueue.main.async { self?.playerItemChanged() }
      },
    ]
  }

  @discardableResult
  private func activateSession() -> Bool {
    do {
      try AVAudioSession.sharedInstance().setActive(true)
      return true
    } catch {
      AudioLog.error("audio.session.activate_failed \(Self.describe(error))")
      return false
    }
  }

  private func deactivateSession() {
    do {
      try AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    } catch {
      AudioLog.warn("audio.session.deactivate_failed \(Self.describe(error))")
    }
  }

  /// PLAY-FOCUS-01 items 1 and 2: a call, an alarm or Siri holds the music back (`suppressed`, `playWhenReady` kept)
  /// and it plays again by itself when the system says it may; an end without that (another app kept the sound) is a
  /// pause, as the user's own. A pause or play pressed meanwhile wins.
  @objc private func interruption(_ notification: Notification) {
    let info = notification.userInfo ?? [:]
    let typeValue = (info[AVAudioSessionInterruptionTypeKey] as? NSNumber)?.uintValue ?? 0
    let optionsValue = (info[AVAudioSessionInterruptionOptionKey] as? NSNumber)?.uintValue ?? 0
    // The reason key replaces the deprecated "was suspended" key; reason 1 is `.appWasSuspended` (a began delivered
    // late, once the app was back: no interruption is going on), compared raw because that case is deprecated too.
    // tvOS has no reason key (PAR-TV-01): every began there is a live interruption.
    #if os(iOS)
      let reason = (info[AVAudioSessionInterruptionReasonKey] as? NSNumber)?.uintValue ?? 0
      let wasSuspended = reason == 1
    #else
      let wasSuspended = false
    #endif
    DispatchQueue.main.async { [self] in
      switch AVAudioSession.InterruptionType(rawValue: typeValue) {
      case .began:
        AudioLog.info(
          "audio.interruption type=began play_when_ready=\(playWhenReady) was_suspended=\(wasSuspended)")
        // An interruption delivered late because the app was suspended is already over.
        if playWhenReady && !wasSuspended { suppressed = true }
      case .ended:
        let shouldResume = AVAudioSession.InterruptionOptions(rawValue: optionsValue).contains(.shouldResume)
        AudioLog.info(
          "audio.interruption type=ended should_resume=\(shouldResume) suppressed=\(suppressed) "
            + "play_when_ready=\(playWhenReady)")
        guard suppressed else { break }
        suppressed = false
        guard playWhenReady else { break }
        if shouldResume && activateSession() {
          player.play()
        } else {
          playWhenReady = false
          player.pause()
        }
      default:
        AudioLog.warn("audio.interruption type=unknown raw=\(typeValue)")
      }
      emit()
    }
  }

  /// PLAY-FOCUS-01 item 4: the headphones or the Bluetooth headset went away; pause rather than play on the speaker
  /// (Android's becoming-noisy), which also cancels a resume pending after a call.
  @objc private func routeChange(_ notification: Notification) {
    let reasonValue = (notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? NSNumber)?.uintValue ?? 0
    let reason = AVAudioSession.RouteChangeReason(rawValue: reasonValue)
    DispatchQueue.main.async { [self] in
      let outputs = AVAudioSession.sharedInstance().currentRoute.outputs.map { $0.portType.rawValue }
      AudioLog.info("audio.route reason=\(reasonValue) outputs=\(outputs) play_when_ready=\(playWhenReady)")
      guard reason == .oldDeviceUnavailable, playWhenReady else { return }
      AudioLog.info("audio.route.pause reason=old_device_unavailable")
      playWhenReady = false
      suppressed = false
      player.pause()
      emit()
    }
  }

  /// The system's media services restarted: every player object is dead. A new player picks up where this one was.
  @objc private func mediaServicesReset(_ notification: Notification) {
    DispatchQueue.main.async { [self] in
      AudioLog.warn("audio.session.media_services_reset count=\(queue.count)")
      let position = positionMs
      generation += 1
      tearDownItems()
      playerObservations = []
      if let ticker = upcomingTicker { player.removeTimeObserver(ticker) }
      upcomingTicker = nil
      player = AVQueuePlayer()
      applyVolume()
      observePlayer()
      try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .default)
      if !queue.isEmpty && !ended { jump(to: queue.current, positionMs: position) } else { emit(force: true) }
    }
  }

  private func setUpRemoteCommands() {
    let center = MPRemoteCommandCenter.shared()
    center.playCommand.addTarget { [weak self] _ in
      AudioLog.info("audio.remote command=play")
      self?.play()
      return .success
    }
    center.pauseCommand.addTarget { [weak self] _ in
      AudioLog.info("audio.remote command=pause")
      self?.pause()
      return .success
    }
    center.togglePlayPauseCommand.addTarget { [weak self] _ in
      guard let self else { return .commandFailed }
      AudioLog.info("audio.remote command=toggle play_when_ready=\(self.playWhenReady) suppressed=\(self.suppressed)")
      if self.playWhenReady && !self.suppressed && !self.ended { self.pause() } else { self.play() }
      return .success
    }
    center.nextTrackCommand.addTarget { [weak self] _ in
      AudioLog.info("audio.remote command=next")
      self?.next()
      return .success
    }
    center.previousTrackCommand.addTarget { [weak self] _ in
      AudioLog.info("audio.remote command=previous")
      self?.previous()
      return .success
    }
    center.changePlaybackPositionCommand.addTarget { [weak self] event in
      guard let event = event as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
      AudioLog.info("audio.remote command=seek position_s=\(event.positionTime)")
      self?.seek(to: event.positionTime * 1000)
      return .success
    }
    for command in [
      center.playCommand, center.pauseCommand, center.togglePlayPauseCommand, center.nextTrackCommand,
      center.previousTrackCommand, center.changePlaybackPositionCommand,
    ] {
      command.isEnabled = true
    }
  }

  /// The lock screen's and Control Center's card (PLAY-OSMEDIA-01): the song, its cover, where it is and whether it
  /// plays (a held-back song shows paused, PLAY-FOCUS-01 item 5).
  private func updateNowPlaying() {
    let center = MPRemoteCommandCenter.shared()
    // Only the actions that make sense now (PLAY-OSMEDIA-01 item 2): no next on the last song with repeat off, as
    // Media3 drops its seek-to-next command there. Previous always works (it restarts the song at least).
    let hasNext = queue.currentItem != nil && queue.nextForNavigation >= 0
    if center.nextTrackCommand.isEnabled != hasNext {
      center.nextTrackCommand.isEnabled = hasNext
      AudioLog.info("audio.remote.next enabled=\(hasNext)")
    }
    guard let entry = queue.currentItem else {
      MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
      return
    }
    var info: [String: Any] = [
      MPMediaItemPropertyTitle: entry.title,
      MPNowPlayingInfoPropertyElapsedPlaybackTime: positionMs / 1000,
      MPNowPlayingInfoPropertyPlaybackRate: isPlaying ? 1.0 : 0.0,
      MPNowPlayingInfoPropertyDefaultPlaybackRate: 1.0,
      MPNowPlayingInfoPropertyPlaybackQueueIndex: max(0, queue.current),
      MPNowPlayingInfoPropertyPlaybackQueueCount: queue.count,
      MPNowPlayingInfoPropertyMediaType: MPNowPlayingInfoMediaType.audio.rawValue,
    ]
    if let artist = entry.artist { info[MPMediaItemPropertyArtist] = artist }
    if let album = entry.album { info[MPMediaItemPropertyAlbumTitle] = album }
    if durationMs >= 0 { info[MPMediaItemPropertyPlaybackDuration] = durationMs / 1000 }
    if let artwork = artwork(for: entry.artworkUri) { info[MPMediaItemPropertyArtwork] = artwork }
    MPNowPlayingInfoCenter.default().nowPlayingInfo = info
  }

  /// The cover from a local `file://` picture (never a remote URL), read once per picture.
  private func artwork(for url: URL?) -> MPMediaItemArtwork? {
    guard let url, url.isFileURL else { return nil }
    if let artwork, artwork.url == url { return artwork.artwork }
    guard let image = UIImage(contentsOfFile: url.path) else {
      AudioLog.warn("audio.artwork.unreadable path=\(url.lastPathComponent)")
      return nil
    }
    let made = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
    artwork = (url, made)
    return made
  }

  // MARK: - Errors

  /// A Media3-style error code name for `error`, so JS shows the same kind of name on both phones.
  static func errorName(_ error: Error) -> String {
    let ns = error as NSError
    switch ns.domain {
    case AVFoundationErrorDomain:
      switch ns.code {
      case AVError.Code.fileFormatNotRecognized.rawValue: return "ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED"
      case AVError.Code.failedToParse.rawValue: return "ERROR_CODE_PARSING_CONTAINER_MALFORMED"
      case AVError.Code.decoderNotFound.rawValue:
        return "ERROR_CODE_DECODING_FORMAT_UNSUPPORTED"
      case AVError.Code.decodeFailed.rawValue: return "ERROR_CODE_DECODING_FAILED"
      case AVError.Code.fileFailedToParse.rawValue: return "ERROR_CODE_PARSING_CONTAINER_MALFORMED"
      case AVError.Code.serverIncorrectlyConfigured.rawValue: return "ERROR_CODE_IO_BAD_HTTP_STATUS"
      case AVError.Code.noLongerPlayable.rawValue: return "ERROR_CODE_IO_UNSPECIFIED"
      default: break
      }
    case NSURLErrorDomain:
      switch ns.code {
      case NSURLErrorTimedOut: return "ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT"
      case NSURLErrorCannotConnectToHost, NSURLErrorNetworkConnectionLost, NSURLErrorNotConnectedToInternet,
           NSURLErrorCannotFindHost:
        return "ERROR_CODE_IO_NETWORK_CONNECTION_FAILED"
      case NSURLErrorAppTransportSecurityRequiresSecureConnection: return "ERROR_CODE_IO_CLEARTEXT_NOT_PERMITTED"
      case NSURLErrorFileDoesNotExist: return "ERROR_CODE_IO_FILE_NOT_FOUND"
      case NSURLErrorBadServerResponse, NSURLErrorResourceUnavailable: return "ERROR_CODE_IO_BAD_HTTP_STATUS"
      default: return "ERROR_CODE_IO_UNSPECIFIED"
      }
    default:
      break
    }
    if let underlying = ns.userInfo[NSUnderlyingErrorKey] as? Error { return errorName(underlying) }
    return "ERROR_CODE_UNSPECIFIED"
  }

  /// `domain=… code=… reason=…` of `error` and the errors under it, for the log.
  static func describe(_ error: Error) -> String {
    var parts: [String] = []
    var current: NSError? = error as NSError
    while let ns = current, parts.count < 4 {
      parts.append("domain=\(ns.domain) code=\(ns.code) reason=\"\(ns.localizedFailureReason ?? ns.localizedDescription)\"")
      current = ns.userInfo[NSUnderlyingErrorKey] as? NSError
    }
    return parts.joined(separator: " <- ")
  }
}
