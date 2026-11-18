import type { FfmpegCapability } from "./ffmpegCapabilities";
import { badgerCapabilitiesGetFfmpeg, badgerCapabilitiesTestFfmpeg } from "@space/runtime-contracts";
import { createRuntimeSession, type RuntimeSessionHandle } from "@space/runtime-client/session";
import { createRuntimeCommandClient } from "@space/runtime-client/command";
import { runtimeOwnerSecretProvider } from "./runtimeOwnerSecret";

const DEFAULT_RUNTIME_BASE_URL = "http://127.0.0.1:3020";

export class FfmpegRuntimeBridge {
  private readonly runtimeBaseUrl = String(process.env.SF_RUNTIME_BASE_URL ?? DEFAULT_RUNTIME_BASE_URL)
    .trim()
    .replace(/\/+$/, "");
  private session: RuntimeSessionHandle | null = null;
  private client: ReturnType<typeof createRuntimeCommandClient> | null = null;

  setBackendToken(token: string | null) {
    const normalized = typeof token === "string" && token.trim().length > 0 ? token.trim() : null;
    if (!normalized) {
      this.session = null;
      this.client = null;
      return;
    }
    if (this.session) {
      this.session.setBackendToken(normalized);
    } else {
      this.session = createRuntimeSession({
        runtimeBaseUrl: this.runtimeBaseUrl,
        backendToken: normalized,
        apps: ["badger"],
        ownerSecret: runtimeOwnerSecretProvider,
      });
      this.client = createRuntimeCommandClient({
        session: this.session,
        runtimeBaseUrl: this.runtimeBaseUrl,
        requestIdPrefix: "desktop-ffmpeg",
      });
    }
  }

  async getCapabilities() {
    if (!this.client) return null;
    try {
      const result = await this.client.sendCommand(badgerCapabilitiesGetFfmpeg, {});
      return result as unknown as FfmpegCapability | null;
    } catch {
      return null;
    }
  }

  async runCapabilityTest(encoder?: "nvenc" | "qsv" | "vaapi" | "amf" | "videotoolbox" | "cpu") {
    if (!this.client) return null;
    try {
      const result = await this.client.sendCommand(badgerCapabilitiesTestFfmpeg, {
        encoder: encoder ?? undefined,
      });
      return (result ?? null) as FfmpegCapability["lastTest"] | null;
    } catch {
      return null;
    }
  }
}
