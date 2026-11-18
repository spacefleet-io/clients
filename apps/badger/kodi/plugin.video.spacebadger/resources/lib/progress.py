# -*- coding: utf-8 -*-
"""Resume / watched rules (INTG-SYNC-01, PLAY-RESUME-01/02) and the op payloads the desktop reads.

Ported from packages/shared/src/playbackResume.ts and
packages/library-db-runtime/src/libraryDb.ts (setProgress).
"""
import json
import math
import time

RESUME_MIN_PCT = 2.0
RESUME_MIN_SECONDS = 15.0
COMPLETED_PCT = 95.0
# Kodi ignores its own resume bookmarks below this many seconds (advancedsettings default).
KODI_IGNORE_RESUME_BELOW = 180.0


def _finite(value):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) else None


def watched_position(progress_pct, position_seconds=None, duration_seconds=None):
    pos = _finite(position_seconds)
    if pos is not None and pos >= 0:
        return pos
    pct, dur = _finite(progress_pct), _finite(duration_seconds)
    if pct is None or dur is None or dur <= 0:
        return None
    return pct / 100.0 * dur


def is_completed(progress_pct, position_seconds=None, duration_seconds=None, credits_start=None):
    """>= 95% or past the start of the end credits when the credits position is known (PLAY-RESUME-02)."""
    cs = _finite(credits_start)
    if cs is not None and cs > 0:
        pos = watched_position(progress_pct, position_seconds, duration_seconds)
        if pos is not None and pos >= cs:
            return True
    pct = _finite(progress_pct)
    return pct is not None and pct >= COMPLETED_PCT


def resume_candidate_seconds(progress_pct, duration_seconds, credits_start=None, position_seconds=None):
    """Seconds to offer as resume, or None when too trivial / already watched (PLAY-RESUME-01)."""
    pct, dur = _finite(progress_pct), _finite(duration_seconds)
    if pct is None or pct <= 0 or dur is None or dur <= 0:
        return None
    if is_completed(pct, position_seconds, dur, credits_start):
        return None
    persisted = _finite(position_seconds)
    seconds = persisted if persisted is not None and persisted >= 0 else pct / 100.0 * dur
    if pct >= RESUME_MIN_PCT or seconds >= RESUME_MIN_SECONDS:
        return seconds
    return None


def evaluate_stop(position_seconds, duration_seconds, credits_start=None):
    """Decide what to write when playback stops/ends.

    Returns {'write': bool, 'progressPct': float, 'positionSeconds': float, 'durationSeconds': float, 'completed': bool}.
    Below the keep thresholds (2% or 15 s) nothing is written: the previous resume point stays.
    """
    dur = _finite(duration_seconds)
    pos = _finite(position_seconds)
    if dur is None or dur <= 0 or pos is None or pos < 0:
        return {"write": False, "reason": "no_duration_or_position"}
    pos = min(pos, dur)
    pct = max(0.0, min(100.0, pos / dur * 100.0))
    completed = is_completed(pct, pos, dur, credits_start)
    keep = completed or pct >= RESUME_MIN_PCT or pos >= RESUME_MIN_SECONDS
    if not keep:
        return {"write": False, "reason": "below_resume_threshold", "progressPct": pct, "positionSeconds": pos}
    pct4 = max(0.0001, round(pct * 10000) / 10000.0) if pct > 0 else 0.0
    return {
        "write": True,
        "progressPct": pct4,
        "positionSeconds": pos,
        "durationSeconds": dur,
        "completed": completed,
    }


def movie_progress_payload(media_id, progress_pct, timestamp):
    """media.progress payload (movie: the item's own progress)."""
    return {"mediaId": media_id, "progressPct": progress_pct, "lastWatchedAt": timestamp, "updatedAt": timestamp}


def episode_resume_setting(episode_id, progress_pct, timestamp, position_seconds=None, duration_seconds=None, prefix=""):
    """setting.set payload for [p:<pid>:]episode_resume_v1:<episodeId> (libraryDb.ts:4297-4336); `prefix` = the
    followed profile's key prefix ("" for the main profile, INTG-PROF-01)."""
    payload = {"progressPct": progress_pct, "updatedAt": timestamp}
    if _finite(position_seconds) is not None and position_seconds >= 0:
        payload["positionSeconds"] = position_seconds
    if _finite(duration_seconds) is not None and duration_seconds > 0:
        payload["durationSeconds"] = duration_seconds
    return {
        "key": "%sepisode_resume_v1:%s" % (prefix, episode_id),
        "value": json.dumps(payload, separators=(",", ":")),
        "updatedAt": timestamp,
    }


def air_date_today():
    """Today as YYYY-MM-DD (UTC), the form catalog air dates use (showProgress.ts airDateToday)."""
    return time.strftime("%Y-%m-%d", time.gmtime())


def _is_regular(season_number):
    season = _finite(season_number)
    return season is not None and season > 0


def show_episode_total(episodes, total_episodes, today):
    """LIB-PROG-01 (packages/shared/src/showProgress.ts showEpisodeTotal): the number of episodes a show's watched %
    is counted out of. episodes = [(season_number, air_date)]. Aired regular episodes (season 1+, air date <= today),
    else the metadata's total_episodes, else the regular episodes listed. Returns (total, source) or None."""
    regular = [(s, a) for s, a in episodes if _is_regular(s)]
    aired = sum(1 for _, a in regular if isinstance(a, str) and len(a[:10]) == 10 and a[:10] <= today)
    if aired > 0:
        return aired, "aired"
    metadata = _finite(total_episodes)
    if metadata is not None and metadata > 0:
        return int(math.floor(metadata)), "metadata"
    return (len(regular), "episodes") if regular else None


def show_watched_pct(watched, total):
    """LIB-PROG-01 (showProgress.ts showWatchedPct): summed clamped % of the regular episodes over total.
    watched = [(season_number, progress_pct)]; specials never count."""
    if _finite(total) is None or total <= 0:
        return 0.0
    sum_pct = 0.0
    for season, pct in watched:
        pct = _finite(pct)
        if _is_regular(season) and pct is not None:
            sum_pct += max(0.0, min(100.0, pct))
    return max(0.0, min(100.0, sum_pct / total))


def show_aggregate(episodes, total_episodes_configured, resumes_by_episode, today=None):
    """TV show aggregate progress (libraryDb.ts getTvProgressAggregate, LIB-PROG-01). episodes = media_episodes rows
    (id, season_number, air_date); resumes_by_episode = {episodeId: episode_resume_v1 record}."""
    total = show_episode_total([(e.get("season_number"), e.get("air_date")) for e in episodes],
                               total_episodes_configured, today or air_date_today())
    if total is None:
        return None
    season_by_id = dict((e.get("id"), e.get("season_number")) for e in episodes)
    watched = []
    latest = None
    for episode_id, r in resumes_by_episode.items():
        watched.append((season_by_id.get(episode_id, 0), r.get("progressPct")))
        ts = r.get("updatedAt")
        if ts and (latest is None or ts > latest):
            latest = ts
    return {"progressPct": show_watched_pct(watched, total[0]), "lastWatchedAt": latest, "total": total[0], "source": total[1]}
