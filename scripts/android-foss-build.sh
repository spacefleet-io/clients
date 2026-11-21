#!/usr/bin/env bash
# The Google-free Android release build (SF_FOSS=1, PLAT-MOBILE-06): the same recipe for F-Droid's build server,
# the APK attached to our releases, and anyone rebuilding either to compare.
#
#   [SF_VERSION_CODE=<n> SF_VERSION_NAME=<name>] scripts/android-foss-build.sh <badger|parrot>
#
# The version defaults to apps/<app>/mobile/android/version.properties, which every public release tag carries
# (REL-DIST-22); without that file both variables are required.
#
# Needs bun, a JDK 21 and an Android SDK with NDK 27.1.12297006 (ANDROID_HOME). Run it after any Play build
# in a separate invocation: it cleans the app first. The build leaves out Firebase, Google Cast and the ML Kit QR
# scanner (packages/mobile-shell/foss.cjs). It can send error reports, off until the user turns them on (REL-LOG-06):
# the reporting addresses come from the committed scripts/android-foss-error-report.env, never from the calling
# environment, so every rebuild (F-Droid's included) bakes in the same ones. The bundle gets a debug ID; uploading
# its source map to Bugsink is the release workflow's job, never this script's.
#
# Signing: with <APP>_UPLOAD_STORE_FILE and its passwords in the environment (or as gradle properties) the APK is
# signed with the upload key, otherwise it is left unsigned for F-Droid to sign. reactNativeArchitectures picks the
# ABIs (default: the app's gradle.properties, every ABI for both apps). GRADLE_OPTS is passed through to Gradle.
# Badger's libmpv (packages/media-deps, android-<arch>) is the published bundle (bun scripts/fetch-deps.ts) by default;
# with SF_MEDIA_DEPS_FROM_SOURCE=1 (F-Droid's build server) it is built here from the pinned sources of the same recipe,
# at the Docker build's paths, so the libraries are byte-identical to the published ones (packages/media-deps/scripts/
# build-android-host.ts, which lists the host tools and the directories it needs).
#
# The APK carries the self-updater (REL-UPD-06: @space/mobile-self-update, its native module and the
# REQUEST_INSTALL_PACKAGES permission), the same for our repository, the website and F-Droid's build server; on
# device it acts only when no store or updater app manages the install.
#
# The last line of stdout is the absolute path of the built APK.
set -euo pipefail

app="${1:-}"
case "$app" in
  badger | parrot) ;;
  *) echo "usage: [SF_VERSION_CODE=<n> SF_VERSION_NAME=<name>] $0 <badger|parrot>" >&2; exit 2 ;;
esac

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
mobile="apps/$app/mobile"

version_file="$mobile/android/version.properties"
if [ -f "$version_file" ]; then
  : "${SF_VERSION_CODE:=$(sed -n 's/^versionCode=//p' "$version_file")}"
  : "${SF_VERSION_NAME:=$(sed -n 's/^versionName=//p' "$version_file")}"
fi
: "${SF_VERSION_CODE:?SF_VERSION_CODE is required}"
: "${SF_VERSION_NAME:?SF_VERSION_NAME is required}"
[[ "$SF_VERSION_CODE" =~ ^[1-9][0-9]*$ ]] || { echo "bad SF_VERSION_CODE '$SF_VERSION_CODE'" >&2; exit 2; }
[[ "$SF_VERSION_NAME" =~ ^[0-9A-Za-z][0-9A-Za-z.+-]*$ ]] || { echo "bad SF_VERSION_NAME '$SF_VERSION_NAME'" >&2; exit 2; }

# The reporting addresses come from the committed file only, and no dev ticket key, whatever the calling environment
# carries. The debug ID is always on, so a rebuild of the same source gives the same bundle.
unset SF_DEV_TICKET_KEY
while IFS= read -r name; do unset "$name"; done < <(compgen -e | grep '^SF_BUGSINK_' || true)
set -a
# shellcheck source=android-foss-error-report.env
. "$root/scripts/android-foss-error-report.env"
set +a
export SF_ERROR_REPORT_SOURCEMAPS=1

bun install --frozen-lockfile >&2
bun run --cwd "$mobile" error-report-config >&2

if [ "$app" = badger ]; then
  # libmpv for every ABI the APK carries (@space/mobile-mpv-playback): downloaded, or built from source.
  default_abis=$(sed -n 's/^reactNativeArchitectures=//p' "$mobile/android/gradle.properties")
  IFS=',' read -r -a abis <<< "${reactNativeArchitectures:-$default_abis}"
  for abi in "${abis[@]}"; do
    case "$abi" in
      armeabi-v7a) target=android-arm ;;
      arm64-v8a) target=android-arm64 ;;
      x86) target=android-ia32 ;;
      x86_64) target=android-x64 ;;
      *) echo "unknown ABI '$abi'" >&2; exit 2 ;;
    esac
    if [ "${SF_MEDIA_DEPS_FROM_SOURCE:-}" = 1 ]; then
      bun packages/media-deps/scripts/build-android-host.ts --target "$target" --docker-paths >&2
    else
      bun scripts/fetch-deps.ts --target "$target" >&2
    fi
  done
fi

export SF_FOSS=1
gradle_args=(
  --no-daemon
  # A Gradle property, not -D: KGP ignores the system property and forks a KotlinCompileDaemon (REL-ENV-40).
  -Pkotlin.compiler.execution.strategy=in-process
  "-P${app}VersionCode=$SF_VERSION_CODE"
  "-P${app}VersionName=$SF_VERSION_NAME"
)
[ -n "${reactNativeArchitectures:-}" ] && gradle_args+=("-PreactNativeArchitectures=$reactNativeArchitectures")
# clean runs on its own: in one invocation with assembleRelease, after an earlier (Play) build in the same checkout,
# Gradle ran the subprojects' clean (ordered only within its own project) after react-native-reanimated's up-to-date prefab tasks, deleting their output, and the
# app's CMake configure failed on the missing prefab directory (badger-android-release run 14645).
(cd "$mobile/android" && ./gradlew "${gradle_args[@]}" clean >&2)
(cd "$mobile/android" && ./gradlew "${gradle_args[@]}" :app:assembleRelease >&2)

out="$root/$mobile/android/app/build/outputs/apk/release"
apk="$out/app-release.apk"
[ -f "$apk" ] || apk="$out/app-release-unsigned.apk"
[ -f "$apk" ] || { echo "no APK in $out" >&2; exit 1; }
echo "$apk"
