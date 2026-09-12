import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const resources = join(root, "dist", "resources");
await readFile(join(root, "..", "host", "dist", "host.cjs"));
await readFile(join(root, "..", "ui", "dist", "index.html"));
await rm(resources, { recursive: true, force: true });
await mkdir(resources, { recursive: true });
await cp(join(root, "..", "host", "dist", "host.cjs"), join(resources, "host.cjs"));
await cp(join(root, "..", "ui", "dist"), join(resources, "ui"), { recursive: true });
for (const asset of ["icon.png", "tray.png", "icon.icns", "entitlements.mac.plist"]) {
  await readFile(join(root, "assets", asset));
}
console.log("Staged only the RAPP Work UI, host, and native identity assets.");
