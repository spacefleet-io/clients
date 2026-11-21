import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ANDROID_STEPS, androidHostScripts, relocateAndroidRecipe, withoutNdkDownload } from "../src/androidHost";
import { getPackageRoot } from "../src/plan";

const recipe = path.join(getPackageRoot(), "recipes", "_android");
const read = (file: string) => readFileSync(path.join(recipe, file), "utf8");

/** @req REL-DIST-22 F-Droid builds Badger's libmpv from source with the recipe's own scripts, at the Docker paths. */
describe("android host build scripts", () => {
  it("are the recipe's files unchanged at the Docker paths, except the NDK download", () => {
    const scripts = androidHostScripts(getPackageRoot());
    expect(Object.keys(scripts)).toEqual(["env.sh", ...ANDROID_STEPS.map((step) => `steps/${step}.sh`)]);
    expect(scripts["env.sh"]).toBe(read("env.sh"));
    for (const step of ANDROID_STEPS.filter((step) => step !== "toolchain")) expect(scripts[`steps/${step}.sh`]).toBe(read(`steps/${step}.sh`));

    const toolchain = read("steps/toolchain.sh").split("\n");
    const hosted = scripts["steps/toolchain.sh"]!.split("\n");
    const dropped = toolchain.filter((line) => !hosted.includes(line));
    expect(dropped).toHaveLength(5);
    expect(dropped.join("\n")).toMatch(/\$NDK_URL/);
    expect(hosted.join("\n")).not.toMatch(/ndk\.zip|curl /);
    // The step still checks the NDK it is given.
    expect(hosted.join("\n")).toMatch(/Pkg\.Revision = \$NDK_VERSION/);
  });

  it("move the Docker roots under the work tree, and nothing else", () => {
    expect(relocateAndroidRecipe('cd /work/mpv && cp "/opt/deps/lib" /recipe/jni; echo /optional /workflow x/opt', "/tmp/t")).toBe(
      'cd /tmp/t/work/mpv && cp "/tmp/t/opt/deps/lib" /tmp/t/recipe/jni; echo /optional /workflow x/opt',
    );
    expect(relocateAndroidRecipe("PREFIX=/opt/deps\n:/opt", "/r")).toBe("PREFIX=/r/opt/deps\n:/r/opt");
    const moved = androidHostScripts(getPackageRoot(), "/tmp/sf-media-deps/android-arm64");
    for (const text of Object.values(moved)) expect(text).not.toMatch(/(^|[\s"'=(:])\/(opt|work|recipe)(?=[/\s"']|$)/m);
  });

  it("refuse a toolchain step whose NDK download changed", () => {
    expect(() => withoutNdkDownload("set -eu\necho android\n")).toThrow(/toolchain\.sh changed/);
  });
});
