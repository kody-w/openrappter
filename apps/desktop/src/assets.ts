import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

const mediaTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2",
};
export function assetPath(url: string, directory: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "rapp-work:" || parsed.hostname !== "app" || parsed.port || parsed.username || parsed.password) return null;
    const pathname = decodeURIComponent(parsed.pathname);
    if (pathname.includes("\\") || pathname.includes("\0") || pathname.split("/").some((part) => part === "..")) return null;
    const root = resolve(directory);
    const path = resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!path.startsWith(root + sep) || !mediaTypes[extname(path)]) return null;
    return path;
  } catch { return null; }
}
export function contentSecurityPolicy(html: string): string {
  const hashes = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) =>
    `'sha256-${createHash("sha256").update(match[1]!).digest("base64")}'`);
  return `default-src 'none'; script-src 'self' ${hashes.join(" ")}; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
}
export async function serveAsset(url: string, directory: string, csp: string): Promise<Response> {
  const path = assetPath(url, directory);
  if (!path) return new Response("Not found", { status: 404 });
  try {
    const [root, actual] = await Promise.all([realpath(directory), realpath(path)]);
    if (!actual.startsWith(root + sep)) return new Response("Not found", { status: 404 });
    return new Response(new Uint8Array(await readFile(actual)), {
      headers: {
        "Content-Type": mediaTypes[extname(path)]!,
        "Content-Security-Policy": csp, "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
      },
    });
  } catch { return new Response("Not found", { status: 404 }); }
}
