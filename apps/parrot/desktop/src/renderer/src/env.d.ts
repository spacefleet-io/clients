/// <reference types="vite/client" />
import type { ParrotBridge } from "../../shared/ipc";

declare global {
  interface Window {
    parrot: ParrotBridge;
  }
}
