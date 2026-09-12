import { build } from "esbuild";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = join(root, "dist");
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await Promise.all([
  build({
    entryPoints: [join(root, "src/main.ts")], outfile: join(output, "main.js"),
    bundle: true, platform: "node", target: "node22", format: "esm", external: ["electron", "ws", "zod"],
  }),
  build({
    entryPoints: [join(root, "src/preload.ts")], outfile: join(output, "preload.cjs"),
    bundle: true, platform: "node", target: "node22", format: "cjs", external: ["electron"],
  }),
]);
