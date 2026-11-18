import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    clearMocks: true,
    mockReset: true,
    restoreMocks: true,
  },
  // Prevent Vite from trying to transform bun:sqlite (it's a Bun runtime built-in)
  optimizeDeps: {
    exclude: ["bun:sqlite"],
  },
  build: {
    rollupOptions: {
      external: ["bun:sqlite"],
    },
  },
});
