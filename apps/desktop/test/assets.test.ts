import { randomUUID } from "node:crypto";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assetPath, contentSecurityPolicy, serveAsset } from "../src/assets.js";

let root: string;
beforeEach(async () => {
  root = join(process.cwd(), ".test-scratch", randomUUID());
  await mkdir(join(root, "ui"), { recursive: true });
  await writeFile(join(root, "ui", "index.html"), "<html><body>RAPP Work</body></html>");
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
describe("local renderer resource boundary", () => {
  it("serves only packaged application resources with a restrictive CSP", async () => {
    const policy = contentSecurityPolicy("<script>document.documentElement.dataset.theme='dark';</script>");
    const response = await serveAsset("rapp-work://app/index.html", join(root, "ui"), policy);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Security-Policy")).toContain("connect-src 'none'");
    expect(policy).toContain("'sha256-");
    expect(policy).not.toMatch(/unsafe-inline|unsafe-eval|\*/);
  });
  it("rejects other schemes, encoded traversal, unsupported files, and linked escapes", async () => {
    const ui = join(root, "ui");
    for (const url of ["https://example.invalid/index.html", "file:///etc/passwd", "rapp-work://elsewhere/index.html", "rapp-work://app/%2e%2e%2fsecret.html", "rapp-work://app/%00.css", "rapp-work://app/file.json"]) {
      expect(assetPath(url, ui)).toBeNull();
    }
    await writeFile(join(root, "outside.html"), "outside");
    await symlink(join(root, "outside.html"), join(ui, "linked.html"));
    expect((await serveAsset("rapp-work://app/linked.html", ui, "default-src 'none'")).status).toBe(404);
  });
});
