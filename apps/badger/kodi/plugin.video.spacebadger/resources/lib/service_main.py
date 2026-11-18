# -*- coding: utf-8 -*-
"""Background service: local HLS server, periodic sync, progress write-back, track memory, skip, Up Next, anonymous ticket refill."""
import base64
import json
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor

import core
import export
import hls
import kodi_rpc
import localized_texts
import playback
import progress as prog
import profiles
import skip_ui
import stream_slot
import syncer
import tickets
import tracks
from api import PlaybackStoppedError, UnauthorizedError
from compat import ADDON_ID, get_prop, get_setting, localized, log, notify, set_prop
from library import now_iso

import xbmc
import xbmcgui

POLL_SECONDS = 1.0
TICKET_POLL_SECONDS = 10.0  # how often the ticket schedule looks at its clock and the sign-in (cheap, non-blocking)
TRACK_POLL_SECONDS = 3.0
UNAVAILABLE_NOTICE_SECONDS = 30.0


class SbPlayer(xbmc.Player):
    def __init__(self, service):
        xbmc.Player.__init__(self)
        self.service = service

    def onAVStarted(self):
        self.service.on_av_started()

    def onPlayBackStopped(self):
        self.service.on_stopped(ended=False)

    def onPlayBackEnded(self):
        self.service.on_stopped(ended=True)

    def onPlayBackError(self):
        self.service.on_stopped(ended=False)


class Service(object):
    def __init__(self):
        self.monitor = xbmc.Monitor()
        self.player = SbPlayer(self)
        self.server = hls.PlaybackServer(core.Context, uuid.uuid4().hex, on_unavailable=self.on_playback_unavailable)
        self.lock = threading.RLock()
        self.cur = None  # current playback tracking dict
        self.stream = None  # stream_slot.Holder of the place the play handler took (ACCT-STREAM-01/04)
        self.pool = ThreadPoolExecutor(max_workers=1)
        self.sync_thread = None
        self.last_sync = 0.0
        self.last_unavailable = 0.0
        self.settings_dirty = True
        # META-ANON-02: the ticket reserve refills here, on its own schedule (start, then about every 6 h), never from a lookup.
        self.tickets = tickets.RefillScheduler(tickets.TicketReserve(core.ticket_store(), core.ticket_auth), core.ticket_session,
                                               aborted=self.monitor.abortRequested)
        self.last_ticket_poll = 0.0
        self.background = syncer.BackgroundGate(self.player.isPlaying)
        self.reset_seen = get_prop("server_reset")
        self.settings_monitor = _SettingsMonitor(self)

    # -------------------------------------------------------------- lifecycle
    def run(self):
        # Show the account-server setting only on a dev run (ACCT-AUTH-09); the code ignores it otherwise anyway.
        core.sync_dev_mode_setting()
        self.server.start()
        set_prop("server", self.server.base)
        log("service started; HLS server %s" % self.server.base)
        while not self.monitor.abortRequested():
            try:
                self.tick()
            except Exception as exc:  # noqa: BLE001
                log("service tick failed: %s" % exc, "error")
            if self.monitor.waitForAbort(POLL_SECONDS):
                break
        log("service stopping")
        self.server.stop()
        set_prop("server", "")
        self.pool.shutdown(wait=False)

    def on_playback_unavailable(self, error):
        """A saturated silo refused or stopped playback (STOR-BW-07, STOR-BW-08): tell the user once and end the dead stream.
        Nothing resumes by itself; the user presses play again once the silo lifted."""
        now = time.time()
        with self.lock:
            if now - self.last_unavailable < UNAVAILABLE_NOTICE_SECONDS:
                return
            self.last_unavailable = now
        notify("Badger", playback.unavailable_message(error), ms=10000)
        if isinstance(error, PlaybackStoppedError) and self.player.isPlayingVideo():
            self.player.stop()

    def tick(self):
        if self.settings_dirty:
            self.settings_dirty = False
            self.apply_settings()
        reset = get_prop("server_reset")
        if reset != self.reset_seen:
            self.reset_seen = reset
            self.server.reset()
            log("server context reset (sign-in/out or sync)")
        # Boot and playback come first: no sync or ticket refill in the first seconds after Kodi started the service or
        # while the player plays (low-end boxes stutter when both compete); held-back work starts once the gate opens.
        if self.background.open():
            interval = max(5, int(get_setting("sync_interval_minutes") or 30)) * 60
            if time.time() - self.last_sync > interval and not (self.sync_thread and self.sync_thread.is_alive()):
                self.start_sync()
            if time.time() - self.last_ticket_poll >= TICKET_POLL_SECONDS:
                self.last_ticket_poll = time.time()
                self.tickets.poll()
        self.track_playback()

    def apply_settings(self):
        import pair_ui  # "Who uses this Kodi?" for a manual sign-in on a multi-profile account (INTG-PROF-01)
        status = core.apply_settings_credentials(choose=pair_ui.choose_profile)
        if status:
            log("settings applied: %s" % status)
            notify("Badger", status)
        self.server.reset()
        self.last_sync = 0.0  # sync soon

    def start_sync(self):
        self.last_sync = time.time()

        def work():
            ctx = core.Context()
            ok, message = syncer.run_sync(ctx)
            log("background sync: %s %s" % (ok, message))
            if ok:
                self.server.reset()
                if get_setting("auto_export") == "true":
                    self.pool.submit(self.push_watch_state)
            elif message not in ("not signed in", "no library key") and not profiles.paused(core.load_state()):
                notify("Badger", "Sync problem: %s" % message)  # a paused profile was announced once by follow_profile

        self.sync_thread = threading.Thread(target=work, name="sb-sync", daemon=True)
        self.sync_thread.start()

    def push_watch_state(self):
        try:
            ctx = core.Context()
            export.push_watch_state(ctx)
        except Exception as exc:  # noqa: BLE001
            log("push watch state failed: %s" % exc, "warning")

    # -------------------------------------------------------------- playback tracking
    def _ours(self):
        """Info dict from the play handler when the player is playing our HLS URL, else None."""
        try:
            if not self.player.isPlayingVideo():
                return None
            playing = self.player.getPlayingFile()
        except RuntimeError:
            return None
        base = get_prop("server")
        if not base or not playing.startswith(base):
            return None
        try:
            return json.loads(get_prop("nowplaying"))
        except ValueError:
            return None

    def on_av_started(self):
        info = self._ours()
        if not info:
            return
        with self.lock:
            self.cur = {
                "info": info, "pos": 0.0, "total": 0.0, "started": time.time(), "skipped_intro": False,
                "skipped_credits": False, "last_track_poll": 0.0, "audio": None, "sub": None, "tracks_applied": False,
                "upnext_sent": False,
            }
        log("playback started: %s" % {k: info.get(k) for k in ("mediaId", "episodeId", "title", "season", "episode")})
        self.hold_stream()
        self.apply_resume(info)
        self.apply_remembered_tracks()
        self.send_upnext()

    # -------------------------------------------------------------- stream place (ACCT-STREAM-01..04)
    def hold_stream(self):
        """Keep the place the play handler took: heartbeats every 20 s from here, given back on stop."""
        try:
            taken = json.loads(get_prop("stream") or "{}")
        except ValueError:
            taken = {}
        set_prop("stream", "")
        if not taken.get("streamId"):
            return
        with self.lock:
            self.stream = stream_slot.Holder(lambda: core.Context().api, taken.get("profileId"), taken["streamId"],
                                             taken.get("language") or "en", time.time())

    def beat_stream(self, holder):
        message = holder.beat()
        if not message:
            return
        with self.lock:
            if self.stream is not holder:
                return  # stopped or replaced meanwhile
            self.stream = None
        # ACCT-STREAM-02: another device chose Play here; its place is gone, so nothing is given back.
        log("stream place taken by another device: %s" % message)
        self.player.stop()
        notify("Badger", message)

    def apply_resume(self, info):
        target = info.get("resume")
        if not target:
            return
        try:
            pos = self.player.getTime()
            if pos < target - 3:
                self.player.seekTime(float(target))
                log("resume: seek %.1fs -> %.1fs (StartOffset not honoured)" % (pos, target))
            else:
                log("resume: already at %.1fs (target %.1fs)" % (pos, target))
        except RuntimeError as exc:
            log("resume seek failed: %s" % exc, "warning")

    def track_playback(self):
        with self.lock:
            cur = self.cur
        if not cur:
            return
        try:
            if not self.player.isPlayingVideo():
                return
            pos, total = self.player.getTime(), self.player.getTotalTime()
        except RuntimeError:
            return
        cur["pos"], cur["total"] = pos, total
        info = cur["info"]
        holder = self.stream
        if holder and holder.due(time.time()):
            self.pool.submit(self.beat_stream, holder)
        self.maybe_skip(cur, info, pos, total)
        if time.time() - cur["last_track_poll"] > TRACK_POLL_SECONDS:
            cur["last_track_poll"] = time.time()
            self.save_track_changes(cur)

    # -------------------------------------------------------------- skip intro / credits (INTG-KODI-04)
    def maybe_skip(self, cur, info, pos, total):
        for kind, flag, label in (("intro", "skipped_intro", localized(30130, "Skip intro")), ("credits", "skipped_credits", localized(30131, "Skip credits"))):
            marker = info.get(kind)
            if not marker or cur[flag]:
                continue
            start, end = marker
            if start <= pos < end - 2:
                cur[flag] = True  # offer once per playback
                target = end if end < total - 1 else max(0.0, total - 1)
                threading.Thread(target=self.offer_skip, args=(label, end, target), daemon=True).start()

    def offer_skip(self, label, marker_end, target):
        skip_ui.offer(label, marker_end, target, self.player)

    # -------------------------------------------------------------- Up Next
    def send_upnext(self):
        cur = self.cur
        if not cur:
            return
        info = cur["info"]
        if info.get("type") != "tv" or not info.get("nextEpisodeId") or not kodi_rpc.addon_installed("service.upnext"):
            return
        try:
            ctx = core.Context()
            media = ctx.lib.get_media(info["mediaId"])
            cur_ep = ctx.lib.get_episode(info["episodeId"])
            nxt = ctx.lib.get_episode(info["nextEpisodeId"])

            # Up Next declines to play when both episodes carry the same id (it compares them), so every episode needs
            # its own id: the Kodi library id of the exported item, else a distinct synthetic one.
            known = {}
            try:
                for e in kodi_rpc.library_episodes_under(export._our_fragment()):
                    known[(e.get("season"), e.get("episode"))] = (e["episodeid"], e.get("tvshowid", -1))
            except kodi_rpc.RpcError:
                pass

            texts = localized_texts.Localizer(ctx.lib, localized_texts.kodi_language())

            def payload(ep):
                ep = texts.episode(media, ep)
                kid, kshow = known.get((ep["season_number"], ep["episode_number"]), (None, -1))
                return {
                    "episodeid": kid if kid is not None else 1000000 + int(ep["season_number"]) * 1000 + int(ep["episode_number"]),
                    "tvshowid": kshow, "title": ep.get("title") or "", "art": {},
                    "season": ep["season_number"], "episode": ep["episode_number"], "showtitle": media["title"],
                    "plot": ep.get("overview") or "", "playcount": 0, "rating": None, "firstaired": ep.get("air_date") or "",
                    "runtime": 0,
                }
            data = {
                "current_episode": payload(cur_ep),
                "next_episode": payload(nxt),
                "play_url": "plugin://%s/?action=play&media=%s&episode=%s" % (ADDON_ID, info["mediaId"], nxt["id"]),
            }
            credits = info.get("credits")
            if credits and cur["total"]:
                data["notification_offset"] = max(10, int(cur["total"] - credits[0]))
            encoded = base64.b64encode(json.dumps(data).encode("utf-8")).decode("ascii")
            kodi_rpc.call("JSONRPC.NotifyAll", {"sender": ADDON_ID + ".SIGNAL", "message": "upnext_data", "data": [encoded]})
            cur["upnext_sent"] = True
            log("Up Next signalled for next episode %s" % info["nextEpisodeId"])
        except Exception as exc:  # noqa: BLE001
            log("Up Next signal failed: %s" % exc, "warning")

    # -------------------------------------------------------------- remembered tracks
    def _rpc_streams(self):
        players = kodi_rpc.call("Player.GetActivePlayers") or []
        pid = next((p["playerid"] for p in players if p.get("type") == "video"), None)
        if pid is None:
            return None, None
        props = kodi_rpc.call("Player.GetProperties", {"playerid": pid, "properties": [
            "audiostreams", "currentaudiostream", "subtitles", "currentsubtitle", "subtitleenabled"]})
        return pid, props

    def apply_remembered_tracks(self):
        """Apply the synced track_prefs_v1 record of this movie/show at play start (PLAY-TRACK-04 resolution rules)."""
        cur = self.cur
        if not cur:
            return
        info = cur["info"]
        try:
            ctx = core.Context()
            prefs = ctx.lib.track_prefs(info["mediaId"])
            pid, props = self._rpc_streams()
            if props is None:
                return
            log("tracks at start: audio=%s sub=%s | synced prefs=%s" % (
                [(s["index"], s.get("language")) for s in props["audiostreams"]],
                [(s["index"], s.get("language")) for s in props["subtitles"]], prefs))
            if prefs:
                audio_pref = prefs.get("audioLanguage")
                if audio_pref:
                    idx = tracks.find_stream(props["audiostreams"], audio_pref)
                    if idx is None:
                        log("synced audio '%s' not in this file, keeping its default" % audio_pref)
                    elif idx != props["currentaudiostream"]["index"]:
                        kodi_rpc.call("Player.SetAudioStream", {"playerid": pid, "stream": idx})
                        log("applied synced audio '%s' -> stream %s" % (audio_pref, idx))
                sub_pref = prefs.get("subtitle")
                if sub_pref == "off":
                    kodi_rpc.call("Player.SetSubtitle", {"playerid": pid, "subtitle": "off"})
                    log("applied synced subtitles: off")
                elif isinstance(sub_pref, dict):
                    idx = tracks.find_stream(props["subtitles"], sub_pref.get("language"), sub_pref.get("forced", False), sub_pref.get("format"))
                    if idx is None:
                        log("synced subtitle %s not in this file, keeping its default" % sub_pref)
                    else:
                        kodi_rpc.call("Player.SetSubtitle", {"playerid": pid, "subtitle": idx, "enable": True})
                        log("applied synced subtitle %s -> stream %s" % (sub_pref, idx))
            time.sleep(0.5)
            self._snapshot_tracks(cur)
        except Exception as exc:  # noqa: BLE001
            log("apply remembered tracks failed: %s" % exc, "warning")
        cur["tracks_applied"] = True

    def _snapshot_tracks(self, cur):
        _pid, props = self._rpc_streams()
        if props is None:
            return None
        audio = (props.get("currentaudiostream") or {}).get("language") or None
        if props.get("subtitleenabled"):
            cs = props.get("currentsubtitle") or {}
            sub = (cs.get("language") or None, bool(cs.get("isforced")), tracks.stream_format(cs))
        else:
            sub = "off"
        cur["audio"], cur["sub"] = audio, sub
        return audio, sub

    def save_track_changes(self, cur):
        """The user switched audio or subtitles in the player: sync it (not automatic selection)."""
        if not cur.get("tracks_applied"):
            return
        before = (cur["audio"], cur["sub"])
        try:
            now = self._snapshot_tracks(cur)
        except Exception as exc:  # noqa: BLE001
            log("track poll failed: %s" % exc, "debug")
            return
        if now is None or now == before:
            return
        audio, sub = now
        changes = {}
        if audio and audio != before[0]:
            changes["audio"] = audio
        if sub != before[1]:
            if sub == "off":
                changes["subtitle"] = "off"
            elif sub and sub[0]:
                changes["subtitle"] = tracks.subtitle_choice(sub[0], sub[1], sub[2])
        if changes:
            log("user changed tracks %s -> %s" % (before, changes))
            self.pool.submit(self.write_track_prefs, cur["info"], changes)

    def write_track_prefs(self, info, changes):
        """Sync the choice as [p:<pid>:]track_prefs_v1:<movie or show id> of the followed profile (read-modify-write setting.set)."""
        try:
            ctx = core.Context()
            ok, value = ctx.lib.write_track_prefs(ctx.api, ctx.key, info["mediaId"], audio=changes.get("audio"), subtitle=changes.get("subtitle"))
            log("track prefs synced as setting.set %s = %s accepted=%s" % (ctx.lib.track_prefs_key(info["mediaId"]), value, ok))
        except UnauthorizedError:
            core.wipe_everything("401 while writing track prefs")
            set_prop("access", "signedout")
        except Exception as exc:  # noqa: BLE001
            log("track prefs sync failed: %s" % exc, "warning")

    # -------------------------------------------------------------- progress write-back (INTG-SYNC-01)
    def on_stopped(self, ended):
        with self.lock:
            cur, self.cur = self.cur, None
            holder, self.stream = self.stream, None
        if holder:
            self.pool.submit(holder.release)
        if not cur:
            return
        info = cur["info"]
        pos, total = cur["pos"], cur["total"]
        if ended and total:
            pos = total
        credits = info.get("credits")
        credits_start = credits[0] if credits else None
        decision = prog.evaluate_stop(pos, total, credits_start)
        log("playback stopped (ended=%s) pos=%.1f total=%.1f -> %s" % (ended, pos or 0, total or 0, decision))
        if not decision.get("write"):
            return
        self.pool.submit(self.write_progress, info, decision)

    def write_progress(self, info, decision):
        try:
            ctx = core.Context()
            if ctx.lib.viewing_paused:
                log("progress not written: no profile followed (INTG-PROF-01) %s" % (info.get("episodeId") or info["mediaId"]), "warning")
                return
            ts = now_iso()
            pct = decision["progressPct"]
            if info.get("episodeId"):
                ctx.lib.write_viewing(ctx.api, ctx.key, "setting.set", prog.episode_resume_setting(
                    info["episodeId"], pct, ts, decision["positionSeconds"], decision["durationSeconds"], prefix=ctx.lib.prefix))
                media = ctx.lib.get_media(info["mediaId"]) or {}
                episodes = ctx.lib.episodes(info["mediaId"])
                agg = prog.show_aggregate(episodes, media.get("total_episodes"), ctx.lib.all_episode_resumes(info["mediaId"]))
                if agg:
                    log("library.showProgress %s" % json.dumps({"mediaId": info["mediaId"], "total": agg["total"], "source": agg["source"], "progressPct": agg["progressPct"]}))
                    ctx.lib.write_progress(ctx.api, ctx.key, info["mediaId"], agg["progressPct"], agg["lastWatchedAt"] or ts, ts)
            else:
                core.set_media_pref(info["mediaId"], resumeSeconds=decision["positionSeconds"], resumeDuration=decision["durationSeconds"])
                ctx.lib.write_progress(ctx.api, ctx.key, info["mediaId"], pct, ts, ts)
            log("progress written for profile prefix %r: %s %s%% (%.0fs of %.0fs)" % (ctx.lib.prefix, info.get("episodeId") or info["mediaId"], pct, decision["positionSeconds"], decision["durationSeconds"]))
            export.push_watch_state(ctx)
        except UnauthorizedError:
            core.wipe_everything("401 while writing progress")
            set_prop("access", "signedout")
        except Exception as exc:  # noqa: BLE001
            log("progress write failed: %s" % exc, "error")


class _SettingsMonitor(xbmc.Monitor):
    def __init__(self, service):
        xbmc.Monitor.__init__(self)
        self.service = service

    def onSettingsChanged(self):
        self.service.settings_dirty = True


def main():
    Service().run()
