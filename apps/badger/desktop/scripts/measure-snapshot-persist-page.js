// Page half of measure-snapshot-persist.mjs; runs inside the Electron renderer.
(() => {
  const KEY = "sf_library_snapshot_bench-user";
  const iso = (n) => new Date(Date.UTC(2024, 0, 1) + n * 3_600_000).toISOString();
  const words = "orbit nebula comet quasar pulsar galaxy meteor lunar solar stellar cosmic photon".split(" ");
  const text = (n, len) => {
    let out = "";
    for (let i = 0; out.length < len; i += 1) out += words[(n * 7 + i * 3) % words.length] + " ";
    return out.slice(0, len);
  };

  const mediaRow = (i) => {
    const tv = i % 10 < 3;
    return {
      id: `media-${i.toString(36).padStart(6, "0")}-${"a".repeat(20)}`,
      type: tv ? "tv" : "movie",
      catalogId: 100_000 + i,
      title: `${text(i, 24)} ${i}`,
      originalTitle: text(i + 1, 24),
      originalLanguage: "en",
      overview: text(i, 320),
      year: String(1980 + (i % 44)),
      rating: (i % 100) / 10,
      posterPath: `/t/p/w500/${i.toString(36)}poster${"x".repeat(20)}.jpg`,
      backdropPath: `/t/p/w1280/${i.toString(36)}backdrop${"y".repeat(20)}.jpg`,
      genres: [18, 28, 878].slice(0, 1 + (i % 3)),
      addedAt: iso(i),
      updatedAt: iso(i + 5),
      hasFiles: true,
      progressPct: (i * 13) % 100,
      lastWatchedAt: i % 4 === 0 ? iso(i + 9) : null,
      preferredAudioLanguage: null,
      totalEpisodes: tv ? 10 : null,
      episodeCount: tv ? 10 : 0,
      offlineState: "none",
    };
  };

  const details = (row, i) => {
    const tv = row.type === "tv";
    const track = (k, kind) => ({
      id: `${row.id}-${kind}-${k}`,
      fileId: `${row.id}-file-0`,
      index: k,
      language: ["en", "fr", "de"][k % 3],
      label: `${kind} ${k} ${text(k, 16)}`,
      codec: kind === "audio" ? "aac" : "webvtt",
      channels: kind === "audio" ? 6 : null,
      isDefault: k === 0,
      forced: false,
    });
    const subs = [0, 1, 2].map((k) => track(k, "sub"));
    return {
      ...row,
      cast: Array.from({ length: 10 }, (_, k) => ({
        id: `cast-${i}-${k}`,
        name: text(i + k, 18),
        character: text(i + k + 3, 22),
        profilePath: `/t/p/w185/${i}-${k}.jpg`,
        order: k,
      })),
      playlistIds: i % 5 === 0 ? ["pl-favorites"] : [],
      seasons: tv
        ? [1, 2].map((s) => ({ id: `${row.id}-s${s}`, seasonNumber: s, name: `Season ${s}`, overview: text(i + s, 120), posterPath: null, episodeCount: 5 }))
        : [],
      episodes: tv
        ? Array.from({ length: 10 }, (_, e) => ({
            id: `${row.id}-e${e}`,
            seasonNumber: 1 + Math.floor(e / 5),
            episodeNumber: 1 + (e % 5),
            name: text(i + e, 28),
            overview: text(i + e, 180),
            stillPath: `/t/p/w300/${i}-${e}.jpg`,
            airDate: iso(e).slice(0, 10),
            runtime: 52,
            hasFiles: true,
          }))
        : [],
      trailers: [{ id: `${row.id}-tr`, site: "YouTube", key: "dQw4w9WgXcQ", name: "Official Trailer" }],
      files: [
        {
          id: `${row.id}-file-0`,
          episodeId: null,
          kind: "video",
          status: "ready",
          sizeBytes: 4_000_000_000 + i,
          durationSeconds: 6_000,
          manifestKey: `objects/${row.id}/manifest.json`,
          createdAt: iso(i),
        },
      ],
      formats: [
        { id: `${row.id}-f-1080`, fileId: `${row.id}-file-0`, quality: "1080p", codec: "h264", bitrate: 6_000_000 },
        { id: `${row.id}-f-720`, fileId: `${row.id}-file-0`, quality: "720p", codec: "h264", bitrate: 3_000_000 },
      ],
      audioTracks: [0, 1].map((k) => track(k, "audio")),
      subtitleTracks: subs,
      subtitles: subs,
      chapters: Array.from({ length: 6 }, (_, k) => ({ id: `${row.id}-ch${k}`, title: `Chapter ${k + 1}`, startSeconds: k * 900 })),
      skipMarkers: [{ kind: "intro", startSeconds: 30, endSeconds: 90 }],
      hasLocalFiles: true,
    };
  };

  const buildLibrary = (targetBytes) => {
    const media = [];
    const mediaDetailsMap = {};
    const settings = {};
    let bytes = 0;
    for (let i = 0; bytes < targetBytes; i += 1) {
      const row = mediaRow(i);
      media.push(row);
      const d = details(row, i);
      mediaDetailsMap[row.id] = d;
      if (row.type === "tv") {
        for (const ep of d.episodes.slice(0, 4)) {
          settings[`episode_resume_v1:${ep.id}`] = {
            value: JSON.stringify({ progressPct: 42.5, updatedAt: iso(i), positionSeconds: 1300, durationSeconds: 3100 }),
            updatedAt: iso(i),
          };
        }
      }
      if (i % 25 === 0) {
        bytes = JSON.stringify({ media, mediaDetails: Object.values(mediaDetailsMap), settings }).length;
      }
    }
    settings["dashboard_layout_v1"] = { value: JSON.stringify({ sections: ["continue", "recent", "favorites"] }), updatedAt: iso(0) };
    const ingestJobs = Array.from({ length: 12 }, (_, k) => ({
      id: `job-${k}`,
      mediaId: media[k].id,
      fileId: `${media[k].id}-file-0`,
      workerPeerId: "peer-local",
      ownerClientId: "client-1",
      kind: "transcode",
      status: k < 2 ? "processing" : "completed",
      progressPct: k < 2 ? 37 : 100,
      errorCode: null,
      errorMessage: null,
      meta: { quality: "1080p", encoder: "libx264", preset: "veryfast" },
      createdAt: iso(k),
      updatedAt: iso(k + 1),
      completedAt: k < 2 ? null : iso(k + 2),
    }));
    return {
      media,
      playlists: [{ id: "pl-favorites", name: "Favorites", slug: "favorites", isSystem: true, createdAt: iso(0) }],
      playlistItems: { "pl-favorites": media.filter((_, i) => i % 5 === 0).map((m) => m.id) },
      mediaDetailsMap,
      ingestJobs,
      settings,
    };
  };

  // Mirrors libraryContext's save call: Object.values(mediaDetailsMap) + full stringify + setItem.
  const toSnapshot = (state) => ({
    media: state.media,
    playlists: state.playlists,
    playlistItems: state.playlistItems,
    mediaDetails: Object.values(state.mediaDetailsMap),
    ingestJobs: state.ingestJobs,
    settings: state.settings,
  });

  const stats = (values) => {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const pick = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
    const round = (v) => Math.round(v * 100) / 100;
    return {
      n: values.length,
      median: round(pick(0.5)),
      p95: round(pick(0.95)),
      max: round(sorted[sorted.length - 1]),
      total: round(values.reduce((a, b) => a + b, 0)),
    };
  };

  const longTasks = [];
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) longTasks.push({ start: entry.startTime, duration: entry.duration });
  }).observe({ type: "longtask", buffered: false });
  const longTasksBetween = (from, to) => {
    const hits = longTasks.filter((t) => t.start >= from && t.start <= to).map((t) => t.duration);
    return { count: hits.length, ...(stats(hits) ?? { total: 0, max: 0 }) };
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const microBench = async (state, iterations) => {
    const stringifyMs = [];
    const setItemMs = [];
    const totalMs = [];
    const getterMs = [];
    let bytes = 0;
    const from = performance.now();
    for (let i = 0; i < iterations; i += 1) {
      const t0 = performance.now();
      const snap = toSnapshot(state);
      const t1 = performance.now();
      const json = JSON.stringify(snap);
      const t2 = performance.now();
      localStorage.setItem(KEY, json);
      const t3 = performance.now();
      bytes = json.length;
      getterMs.push(t1 - t0);
      stringifyMs.push(t2 - t1);
      setItemMs.push(t3 - t2);
      totalMs.push(t3 - t0);
      await sleep(250); // let each write be its own task
    }
    const sections = {};
    const snap = toSnapshot(state);
    for (const key of Object.keys(snap)) sections[key] = JSON.stringify(snap[key]).length;
    return {
      bytes,
      sectionBytes: sections,
      mediaCount: state.media.length,
      buildSnapshotMs: stats(getterMs),
      stringifyMs: stats(stringifyMs),
      setItemMs: stats(setItemMs),
      perWriteMs: stats(totalMs),
      longTasks: longTasksBetween(from, performance.now()),
    };
  };

  // Playback simulation: a progress write every 500 ms. Each write is
  // followed by the proxy's snapshot push, which hands the renderer new
  // top-level containers (applySnapshot), so every section changes identity.
  const runPolicy = async (name, baseState, config, makePolicy) => {
    let state = { ...baseState };
    const persists = [];
    let lastPersistedTick = 0;
    let tick = 0;
    const save = (snap) => {
      const t0 = performance.now();
      localStorage.setItem(KEY, JSON.stringify(snap));
      const durationMs = performance.now() - t0;
      lastPersistedTick = snap.__tick;
      persists.push({ atS: Math.round((performance.now() - startedAt) / 100) / 10, durationMs: Math.round(durationMs * 100) / 100, tick: snap.__tick });
    };
    const policy = makePolicy(save);
    const startedAt = performance.now();
    const from = startedAt;
    const changeMs = [];
    let maxStaleTicks = 0;
    const target = state.media[3].id;
    const ticks = Math.round((config.playbackS * 1000) / 500);
    console.log(`[bench:${name}] playback ${config.playbackS}s (${ticks} progress writes) then idle ${config.idleS}s`);
    for (tick = 1; tick <= ticks; tick += 1) {
      const pct = (tick / ticks) * 100;
      state = {
        ...state,
        media: state.media.map((m) => (m.id === target ? { ...m, progressPct: pct } : m)),
        mediaDetailsMap: { ...state.mediaDetailsMap },
        settings: { ...state.settings, bench_tick: { value: String(tick), updatedAt: new Date().toISOString() } },
      };
      const captured = state;
      const capturedTick = tick;
      const t0 = performance.now();
      policy.change(() => ({ ...toSnapshot(captured), __tick: capturedTick }));
      changeMs.push(performance.now() - t0);
      maxStaleTicks = Math.max(maxStaleTicks, tick - lastPersistedTick);
      await sleep(500);
    }
    const staleTicksAtPlaybackEnd = ticks - lastPersistedTick;
    const playbackEnd = performance.now();
    const persistsDuringPlayback = persists.length;
    await sleep(config.idleS * 1000);
    const idleEnd = performance.now();
    const t0 = performance.now();
    const flushed = policy.flush();
    const flushMs = performance.now() - t0;
    const persistMs = persists.map((p) => p.durationMs);
    return {
      progressWrites: ticks,
      persistsDuringPlayback,
      persistsTotal: persists.length,
      persistMs: stats(persistMs),
      perChangeOverheadMs: stats(changeMs),
      // Cache staleness if the renderer died at that moment: seconds of
      // progress writes missing from the cold-start cache.
      maxCacheStalenessS: maxStaleTicks / 2,
      cacheStalenessAtPlaybackEndS: staleTicksAtPlaybackEnd / 2,
      cacheCurrentAfterIdle: lastPersistedTick === ticks,
      finalFlushWrote: flushed,
      finalFlushMs: Math.round(flushMs * 100) / 100,
      longTasksPlayback: longTasksBetween(from, playbackEnd),
      longTasksIdleTail: longTasksBetween(playbackEnd, idleEnd),
      persists,
    };
  };

  window.__sfRunBench = async (config) => {
    console.log(`[bench] building ~${config.targetBytes} byte library`);
    const state = buildLibrary(config.targetBytes);
    const micro = await microBench(state, 15);
    console.log(`[bench] micro: ${JSON.stringify(micro)}`);
    const report = { micro };
    if (config.skipPolicy) return report;
    // Before: libraryContext's trailing 10 s debounce, re-armed on every change.
    report.before = await runPolicy("before", state, config, (save) => {
      let timer = null;
      let latest = null;
      return {
        change: (get) => {
          latest = get;
          clearTimeout(timer);
          timer = setTimeout(() => {
            timer = null;
            save(latest());
            latest = null;
          }, 10_000);
        },
        // pagehide flush (only reached on a normal close; win.destroy() skips it).
        flush: () => {
          clearTimeout(timer);
          timer = null;
          if (!latest) return false;
          save(latest());
          latest = null;
          return true;
        },
      };
    });
    console.log(`[bench] before: ${JSON.stringify({ ...report.before, persists: undefined })}`);
    // After: the shipped persister.
    report.after = await runPolicy("after", state, config, (save) => {
      const persister = window.__sfPersister.createLibrarySnapshotPersister({
        save,
        log: (entry) => console.log(`[bench:after:persister] ${JSON.stringify(entry)}`),
      });
      return { change: (get) => persister.markDirty(get), flush: () => persister.flush("quit") };
    });
    console.log(`[bench] after: ${JSON.stringify({ ...report.after, persists: undefined })}`);
    return report;
  };
})();
