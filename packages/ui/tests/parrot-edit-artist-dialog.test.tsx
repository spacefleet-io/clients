// @vitest-environment jsdom
/**
 * @test-id UI-PARROT-EDIT-ARTIST-DIALOG-001
 * @level component (jsdom)
 * @why PAR-META-31: an artist can be edited like a song or an album: its name and its photo, shown round. Save
 *   stays off until something changed; a rename hands back the new name with the photo kept; a picked picture
 *   hands back its bytes; a picture over the size cap is refused at once with a clear line and never sent;
 *   "Use automatic photo" hands the artist back to the automatic fetch; a failed save says why.
 * @req PAR-META-31[parrot]
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { PARROT_COVER_MAX_BYTES } from "@space/parrot-core";
import { ParrotEditArtistDialog, type ParrotArtistPictureChoice, type ParrotEditArtistLabels } from "../src/parrot/manage";

const T = "[parrot-edit-artist-dialog]";

const labels: ParrotEditArtistLabels = {
  title: "Edit artist",
  name: "Name",
  photo: "Photo",
  photoHint: "Drop a picture or a picture link here",
  photoPick: "Choose a picture…",
  photoFrame: "Frame…",
  automatic: "Use automatic photo",
  tooLarge: "This picture is too large (at most 32 MB and 50 megapixels).",
  changed: "changed",
  cancel: "Cancel",
  submit: "Save",
};

let root: Root | null = null;
beforeEach(() => {
  // jsdom has no object URLs; the dialog only needs one to show the preview.
  Reflect.set(URL, "createObjectURL", vi.fn(() => "blob:parrot-test"));
  Reflect.set(URL, "revokeObjectURL", vi.fn());
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  document.body.innerHTML = "";
});

const open = async (props: { onSubmit?: (name: string, picture: ParrotArtistPictureChoice) => void; error?: string; pictureUrl?: string | null } = {}) => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root!.render(
      <ParrotEditArtistDialog
        open
        onOpenChange={() => {}}
        initialName="Neon Pulse AI"
        pictureUrl={props.pictureUrl === undefined ? "https://pictures.test/neon.jpg" : props.pictureUrl}
        labels={labels}
        error={props.error}
        onSubmit={props.onSubmit ?? (() => {})}
      />
    )
  );
  return (testId: string) => document.body.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
};

const submitButton = () => document.body.querySelector<HTMLButtonElement>('[data-testid="manage-artist-submit"]')!;

const rename = async (text: string) => {
  const el = document.body.querySelector<HTMLInputElement>('[data-testid="manage-artist-name"]')!;
  await act(async () => {
    el.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

const pick = async (file: File) => {
  const el = document.body.querySelector<HTMLInputElement>('[data-testid="manage-artist-file"]')!;
  Object.defineProperty(el, "files", { value: [file], configurable: true });
  await act(async () => {
    el.dispatchEvent(new Event("change", { bubbles: true }));
    // takeFile reads the bytes asynchronously.
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 0);
    await promise;
  });
};

describe("[parrot] edit artist dialog (PAR-META-31)", () => {
  it("@req PAR-META-31 Save stays off until the name or the photo changed; a rename keeps the photo", async () => {
    const saved: [string, ParrotArtistPictureChoice][] = [];
    const get = await open({ onSubmit: (name, picture) => saved.push([name, picture]) });
    console.info(T, "opened", get("manage-artist-dialog")?.textContent);
    expect((get("manage-artist-name") as HTMLInputElement).value).toBe("Neon Pulse AI");
    expect(submitButton().disabled).toBe(true);
    await rename("Neon Pulse");
    expect(submitButton().disabled).toBe(false);
    await act(async () => submitButton().click());
    console.info(T, "rename saved", JSON.stringify(saved));
    expect(saved).toEqual([["Neon Pulse", null]]);
  });

  it("@req PAR-META-31 the photo is shown round", async () => {
    const get = await open();
    const preview = get("manage-artist-preview")!;
    console.info(T, "preview", preview.outerHTML);
    expect(preview.className).toContain("rounded-full");
  });

  it("@req PAR-META-31 a picked picture is handed back with its bytes and marked changed", async () => {
    const saved: [string, ParrotArtistPictureChoice][] = [];
    const get = await open({ onSubmit: (name, picture) => saved.push([name, picture]) });
    await pick(new File([new Uint8Array([137, 80, 78, 71])], "face.png", { type: "image/png" }));
    expect(get("manage-artist-changed-photo")?.textContent).toBe("changed");
    expect(get("manage-artist-too-large")).toBeNull();
    await act(async () => submitButton().click());
    console.info(T, "photo saved", saved.map(([name, picture]) => [name, picture && picture !== "automatic" && picture.kind]));
    expect(saved).toHaveLength(1);
    const [name, picture] = saved[0]!;
    expect(name).toBe("Neon Pulse AI");
    if (picture === null || picture === "automatic" || picture.kind !== "file") throw new Error(`expected a file, got ${JSON.stringify(picture)}`);
    expect(picture.mime).toBe("image/png");
    expect([...picture.bytes]).toEqual([137, 80, 78, 71]);
  });

  it("@req PAR-META-31 a huge picture is refused at once with a clear line and never sent", async () => {
    const onSubmit = vi.fn();
    const get = await open({ onSubmit });
    const huge = new File([new Uint8Array([1, 2, 3])], "huge.jpg", { type: "image/jpeg" });
    Object.defineProperty(huge, "size", { value: 10 * 1024 * 1024 * 1024 });
    const read = vi.spyOn(huge, "arrayBuffer");
    await pick(huge);
    console.info(T, "too large", get("manage-artist-too-large")?.textContent, "cap", PARROT_COVER_MAX_BYTES);
    expect(get("manage-artist-too-large")?.textContent).toBe(labels.tooLarge);
    expect(read).not.toHaveBeenCalled();
    expect(get("manage-artist-changed-photo")).toBeNull();
    expect(submitButton().disabled).toBe(true);
    await act(async () => submitButton().click());
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("@req PAR-META-31 Use automatic photo hands the artist back to the automatic fetch", async () => {
    const saved: [string, ParrotArtistPictureChoice][] = [];
    const get = await open({ onSubmit: (name, picture) => saved.push([name, picture]) });
    await act(async () => get("manage-artist-automatic")!.click());
    expect(get("manage-artist-preview")!.dataset.automatic).toBe("true");
    expect((get("manage-artist-automatic") as HTMLButtonElement).disabled).toBe(true);
    await act(async () => submitButton().click());
    console.info(T, "automatic saved", JSON.stringify(saved));
    expect(saved).toEqual([["Neon Pulse AI", "automatic"]]);
  });

  it("@req PAR-META-31 a failed save says why", async () => {
    const get = await open({ error: "Another artist is already called Meltway." });
    expect(get("manage-artist-error")?.textContent).toBe("Another artist is already called Meltway.");
  });
});
