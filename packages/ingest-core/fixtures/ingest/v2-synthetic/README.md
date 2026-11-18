# Synthetic v2 ingest fixtures

Deterministic fixture corpus for the runtime-jobs v2 ingest refactor (plan
§11 + §rollout-Phase-F, spec §8.4). All fixtures are synthesized at test
time by `packages/ingest-core/scripts/generate-v2-fixtures.ts` from
`ffmpeg lavfi` virtual sources — **no large binaries are committed**.

Generated files land under `.cache/` (gitignored). Total corpus size after
generation: **~1.1 MB** for 10 fixtures.

## Generating

```bash
bun run packages/ingest-core/scripts/generate-v2-fixtures.ts          # idempotent
bun run packages/ingest-core/scripts/generate-v2-fixtures.ts --force  # rebuild all
```

CI gate scripts that consume these fixtures should run the generator as a
setup step before any e2e/layer-4 test that depends on them.

## Corpus

| File | Purpose | Notes |
|------|---------|-------|
| `movie.mkv` | Default representative source | 5s, 320x240, 1 EN audio, 1 EN srt subtitle. |
| `Show.S01E01.mkv` | TV episode 1 | 5s blue, EN audio. Filename triggers TV parse. |
| `Show.S01E02.mkv` | TV episode 2 | 7s green, EN audio. Distinct duration from E01. |
| `multi-audio.mkv` | 3-audio source | 1 video + EN/ES/FR audio with `language=...` tags. |
| `text-subtitles.mkv` | Multi-text-subtitles | 5s + EN audio + EN srt + FR srt tracks. |
| `undefined-language.mkv` | Missing language tag | Audio track without `language=` metadata. |
| `no-audio.mkv` | Video-only | Zero audio streams. Probe should accept; ingest path varies (see `e2e-no-audio` historical test). |
| `corrupt.mkv` | Truncated | `movie.mkv` cut to 50% of byte length. Probe should fail or downstream surface clean error. |
| `large.mkv` | Chunk-boundary | 60s 1080p, ~640 KB. "Large" relative to corpus, not actually large. |
| `tiny.mkv` | Pack-instead-of-chunk | 1s 160x120, ~11 KB. Exercises the small-file packed-chunk path. |

## Determinism

The generator passes `-fflags +bitexact -flags:v +bitexact -flags:a +bitexact -map_metadata -1`
to strip muxer time fields and lock encoder bitstream features that would
otherwise drift. Same ffmpeg build → byte-stable outputs across runs on the
same machine. **Cross-version reproducibility is not promised**; the corpus
is regenerated per CI runner. The on-disk `.cache/` is keyed off file
existence + non-zero size, so a stale cache from another ffmpeg version
must be cleared with `--force`.

## Image subtitles — known gap

Spec §8.4 calls for an `image-subtitles.mkv` fixture (DVD-PGS-style). lavfi
cannot synthesize image-based subtitles directly, and we refuse to commit
a real-world sample. Two options when this becomes blocking:

1. Bundle a tiny PGS subtitle stream as a base64-encoded blob in this
   repo and have the generator decode + mux it into the test fixture
   (no actual binary in git, just an inert text payload).
2. Vend it from a fixtures CDN at test time.

Until then, e2e specs that require image subs use the existing
`@known-gap fixture-missing` skip pattern from
`apps/badger/desktop/e2e/ingest-corrupt-fixture.e2e.test.ts`.

## Determinism caveats

- Filename parsing for the TV pair depends on the `Show.S01E01.mkv` shape;
  do not rename in tests — copy/symlink instead.
- `corrupt.mkv` depends on `movie.mkv` already being built, so the recipe
  ordering inside the generator is significant. Do not reorder.
- `large.mkv` is generated at `qp=30` to keep the file at ~640 KB. Do not
  bump quality without budgeting test wall-clock impact.
