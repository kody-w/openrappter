import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const resources = join(root, "dist", "resources");
await readFile(join(root, "..", "host", "dist", "host.cjs"));
await readFile(join(root, "..", "ui", "dist", "index.html"));
await rm(resources, { recursive: true, force: true });
await mkdir(resources, { recursive: true });
await cp(join(root, "..", "host", "dist", "host.cjs"), join(resources, "host.cjs"));
await cp(join(root, "..", "ui", "dist"), join(resources, "ui"), { recursive: true });

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const name = Buffer.from(type);
  const size = Buffer.alloc(4); size.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([size, name, data, crc]);
}
function image(size, tray = false) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const inside = (x, y) => {
    const r = x > .2 && x < .29 && y > .21 && y < .78;
    const top = x > .28 && x < .49 && y > .21 && y < .29;
    const middle = x > .28 && x < .49 && y > .44 && y < .52;
    const bowl = x > .44 && x < .53 && y > .28 && y < .45;
    const leg = y > .5 && y < .78 && Math.abs(x - (.30 + (y - .5) * .7)) < .045;
    const w = y > .44 && y < .78 && (
      Math.abs(x - (.57 + (y - .44) * .21)) < .037 ||
      Math.abs(x - (.71 - (y - .44) * .21)) < .037 ||
      Math.abs(x - (.71 + (y - .44) * .21)) < .037 ||
      Math.abs(x - (.85 - (y - .44) * .21)) < .037);
    return r || top || middle || bowl || leg || w;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const xx = (x + .5) / size, yy = (y + .5) / size;
      const mark = inside(xx, yy);
      const cornerX = Math.max(.18 - xx, 0, xx - .82);
      const cornerY = Math.max(.18 - yy, 0, yy - .82);
      const opaque = cornerX * cornerX + cornerY * cornerY < .18 * .18;
      const offset = y * (size * 4 + 1) + x * 4 + 1;
      const color = tray ? [0, 0, 0, mark ? 255 : 0] : mark ? [255, 255, 255, 255] : [177, 31, 75, opaque ? 255 : 0];
      color.forEach((value, index) => { raw[offset + index] = value; });
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
await mkdir(join(root, "assets"), { recursive: true });
await writeFile(join(root, "assets", "icon.png"), image(1024));
await writeFile(join(root, "assets", "tray.png"), image(32, true));
const icon = image(1024);
const iconChunk = Buffer.alloc(8); iconChunk.write("ic10"); iconChunk.writeUInt32BE(icon.length + 8, 4);
const iconHeader = Buffer.alloc(8); iconHeader.write("icns"); iconHeader.writeUInt32BE(icon.length + 16, 4);
await writeFile(join(root, "assets", "icon.icns"), Buffer.concat([iconHeader, iconChunk, icon]));
console.log("Staged only the RAPP Work UI, host, and native identity assets.");
