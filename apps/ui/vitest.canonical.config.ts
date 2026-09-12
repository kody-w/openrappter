import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { environment: "node", include: ["test/canonical/**/*.spec.ts"], testTimeout: 240_000 },
});
