import {
  chmodSync,
  constants,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { Transform } from "node:stream";


function redactedValue(prefix, doubleQuoted, singleQuoted, _bare, kind) {
  const existing = doubleQuoted ?? singleQuoted ?? _bare ?? "";
  if (
    existing.startsWith("[redacted:")
    || existing.startsWith("<REDACTED")
  ) {
    if (doubleQuoted !== undefined) return `${prefix}"${existing}"`;
    if (singleQuoted !== undefined) return `${prefix}'${existing}'`;
    return `${prefix}${existing}`;
  }
  const marker = `[redacted:${kind}]`;
  if (doubleQuoted !== undefined) return `${prefix}"${marker}"`;
  if (singleQuoted !== undefined) return `${prefix}'${marker}'`;
  return `${prefix}${marker}`;
}

function redactionKindForKey(key) {
  const normalized = String(key || "").toLowerCase().replaceAll("-", "_");
  if (normalized === "user_code" || normalized === "device_code") {
    return "device-code";
  }
  if (normalized.includes("authorization")) return "authorization";
  if (/api_?key/.test(normalized)) return "api-key";
  if (normalized.includes("client_secret") || normalized.includes("secret")) {
    return "secret";
  }
  if (normalized.includes("password") || normalized.includes("passwd")) {
    return "password";
  }
  if (normalized.includes("token")) return "token";
  if (new Set([
    "session_id",
    "user_guid",
    "user_id",
    "username",
    "email",
    "remote",
    "remote_addr",
    "client_ip",
    "ip_address",
  ]).has(normalized)) {
    return "private";
  }
  return null;
}

export function redactCredentialText(value) {
  let scrubbed = String(value);

  scrubbed = scrubbed.replace(
    /((?:\bAuthorization"?\s*[:=]\s*)(?:(?:Bearer|Basic|token)\s+)?)(?:"([^"]*)"|'([^']*)'|([^\s,;&}\]]+))/gi,
    (match, prefix, doubleQuoted, singleQuoted, bare) => (
      redactedValue(
        prefix,
        doubleQuoted,
        singleQuoted,
        bare,
        "authorization",
      )
    ),
  );
  scrubbed = scrubbed.replace(
    /(\bBearer\s+)(?:"([^"]*)"|'([^']*)'|([A-Za-z0-9+/._~=-]+))/gi,
    (match, prefix, doubleQuoted, singleQuoted, bare) => (
      redactedValue(prefix, doubleQuoted, singleQuoted, bare, "bearer")
    ),
  );
  scrubbed = scrubbed.replace(
    /(\b[A-Za-z0-9_-]*(?:api[_-]?key|client_secret|secret|token|password|passwd)[A-Za-z0-9_-]*"?\s*[:=]\s*)(?:"([^"]*)"|'([^']*)'|([^\s,;&}\]]+))/gi,
    (match, prefix, doubleQuoted, singleQuoted, bare) => (
      redactedValue(
        prefix,
        doubleQuoted,
        singleQuoted,
        bare,
        redactionKindForKey(prefix),
      )
    ),
  );
  scrubbed = scrubbed.replace(
    /([?&]code\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^&\s,;}\]]+))/gi,
    (match, prefix, doubleQuoted, singleQuoted, bare) => (
      redactedValue(
        prefix,
        doubleQuoted,
        singleQuoted,
        bare,
        "function-key",
      )
    ),
  );
  scrubbed = scrubbed.replace(
    /(\b(?:azure|function)[^\r\n]{0,40}?\bcode\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^&\s,;}\]]+))/gi,
    (match, prefix, doubleQuoted, singleQuoted, bare) => (
      redactedValue(
        prefix,
        doubleQuoted,
        singleQuoted,
        bare,
        "function-key",
      )
    ),
  );
  scrubbed = scrubbed.replace(
    /(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)(?![A-Za-z0-9_])/g,
    "[redacted:github-token]",
  );
  scrubbed = scrubbed.replace(
    /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?![A-Za-z0-9_-])/g,
    "[redacted:jwt]",
  );
  scrubbed = scrubbed.replace(
    /\b([Cc][Oo][Dd][Ee]|[Ee][Nn][Tt][Ee][Rr]|[Ll][Oo][Gg][Ii][Nn])\b([^\r\n]{0,48}?)\b([A-Z0-9]{4,5}-[A-Z0-9]{4,5})\b/g,
    (match, keyword, between) => (
      `${keyword}${between}[redacted:device-code]`
    ),
  );
  scrubbed = scrubbed.replace(
    /\b([A-Z0-9]{4,5}-[A-Z0-9]{4,5})\b([^\r\n]{0,48}\b(?:[Cc][Oo][Dd][Ee]|[Ee][Nn][Tt][Ee][Rr]|[Ll][Oo][Gg][Ii][Nn])\b)/g,
    (match, code, suffix) => `[redacted:device-code]${suffix}`,
  );

  return scrubbed;
}

export function redactSensitiveValue(value) {
  if (Array.isArray(value)) return value.map(redactSensitiveValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => {
        const kind = redactionKindForKey(key);
        return [
          key,
          kind ? `[redacted:${kind}]` : redactSensitiveValue(item),
        ];
      }),
    );
  }
  return typeof value === "string" ? redactCredentialText(value) : value;
}

export function scrubDiagnosticValue(value, { roots = [] } = {}) {
  const scrubText = (input) => {
    let scrubbed = redactCredentialText(input);
    for (const root of roots) {
      if (!root) continue;
      const escaped = String(root).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      scrubbed = scrubbed.replace(
        new RegExp(escaped, "gi"),
        "<REDACTED_PATH>",
      );
    }
    scrubbed = scrubbed.replace(
      /\b[A-Z]:\\Users\\[^\\\s"'<>|]+(?:\\[^\s"'<>|]*)?/gi,
      "<REDACTED_PATH>",
    );
    scrubbed = scrubbed.replace(
      /\/(?:Users|home)\/[^/\s"'<>|]+(?:\/[^\s"'<>|]*)?/gi,
      "<REDACTED_PATH>",
    );
    scrubbed = scrubbed.replace(
      /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
      "<REDACTED_EMAIL>",
    );
    scrubbed = scrubbed.replace(
      /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g,
      "<REDACTED_IP>",
    );
    return scrubbed.replace(
      /(https?:\/\/[^\s?#]+)[?#][^\s]*/gi,
      "$1?<REDACTED_QUERY>",
    );
  };
  const visit = (item) => {
    if (Array.isArray(item)) return item.map(visit);
    if (item && typeof item === "object") {
      return Object.fromEntries(
        Object.entries(item).map(([key, nested]) => {
          const kind = redactionKindForKey(key);
          return [key, kind ? `[redacted:${kind}]` : visit(nested)];
        }),
      );
    }
    return typeof item === "string" ? scrubText(item) : item;
  };
  return visit(value);
}

export function createExportRedactionScript({ roots = [] } = {}) {
  const safeRoots = roots
    .filter((root) => typeof root === "string" && root)
    .map((root) => path.resolve(root));
  return [
    "(() => {",
    "if (window.__rappFrontierExportRedaction) return;",
    redactedValue.toString(),
    redactionKindForKey.toString(),
    redactCredentialText.toString(),
    redactSensitiveValue.toString(),
    scrubDiagnosticValue.toString(),
    `const roots = ${JSON.stringify(safeRoots)};`,
    "const NativeBlob = window.Blob;",
    "class FrontierRedactedBlob extends NativeBlob {",
    "  constructor(parts = [], options = {}) {",
    "    const mediaType = String(options?.type || '').split(';', 1)[0].trim().toLowerCase();",
    "    const partList = Array.isArray(parts) ? parts : [...parts];",
    "    let safeParts = partList;",
    "    if (mediaType === 'application/json' || mediaType.endsWith('+json')) {",
    "      if (partList.every((part) => typeof part === 'string')) {",
    "        const text = partList.join('');",
    "        try {",
    "          const indentation = text.includes('\\n') ? 2 : undefined;",
    "          safeParts = [JSON.stringify(",
    "            scrubDiagnosticValue(JSON.parse(text), { roots }),",
    "            null,",
    "            indentation,",
    "          )];",
    "        } catch {",
    "          safeParts = [redactCredentialText(text)];",
    "        }",
    "      } else {",
    "        safeParts = partList.map((part) => (",
    "          typeof part === 'string' ? redactCredentialText(part) : part",
    "        ));",
    "      }",
    "    }",
    "    super(safeParts, options);",
    "  }",
    "}",
    "window.Blob = FrontierRedactedBlob;",
    "window.__rappFrontierExportRedaction = true;",
    "})();",
  ].join("\n");
}

// Link the current inode into a free predecessor slot before unlinking its live
// path. Existing predecessors may still have writers, so they are never
// replaced; lifecycle pruning bounds archives after their writers are gone.
export function rotateLogIfLarge(
  filePath,
  {
    maxBytes = 5 * 1024 * 1024,
    maxArchives = 10_000,
    link = linkSync,
  } = {},
) {
  let size;
  try {
    size = statSync(filePath).size;
  } catch {
    return false;
  }
  if (size <= maxBytes) return false;
  const archiveCount = Math.max(
    0,
    Math.floor(Number(maxArchives) || 0),
  );
  for (let index = 1; index <= archiveCount; index += 1) {
    const to = `${filePath}.${index}`;
    try {
      link(filePath, to);
    } catch (error) {
      if (error?.code === "EEXIST") continue;
      return false;
    }
    try {
      rmSync(filePath);
      return true;
    } catch {
      try { rmSync(to, { force: true }); } catch {}
      return false;
    }
  }
  return false;
}

export function pruneLogFiles(directory, {
  keep = 20,
  match = (name) => /\.log(?:\.\d+)?$/.test(name),
  maxAgeMs = 14 * 24 * 60 * 60 * 1000,
  now = Date.now(),
  protectedNames = [],
} = {}) {
  const protectedSet = protectedNames instanceof Set
    ? protectedNames
    : new Set(protectedNames);
  let files = [];
  try {
    files = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && match(entry.name))
      .map((entry) => {
        const full = path.join(directory, entry.name);
        let mtime = 0;
        try { mtime = statSync(full).mtimeMs; } catch {}
        return { full, mtime, name: entry.name };
      });
  } catch {
    return [];
  }
  files.sort((left, right) => right.mtime - left.mtime);
  const keepCount = Math.max(0, Math.floor(Number(keep) || 0));
  const removed = [];
  let retained = 0;
  for (const file of files) {
    if (protectedSet.has(file.name)) continue;
    const expired = now - file.mtime > maxAgeMs;
    if (!expired && retained < keepCount) {
      retained += 1;
      continue;
    }
    try {
      rmSync(file.full, { force: true });
      removed.push(file.name);
    } catch {
      // A live or locked file remains for the next lifecycle pruning pass.
    }
  }
  return removed;
}

export function openPrivateAppendFile(
  filePath,
  { platform = process.platform } = {},
) {
  const directory = path.dirname(filePath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (platform !== "win32") chmodSync(directory, 0o700);
  const fd = openSync(
    filePath,
    constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY,
    0o600,
  );
  if (platform !== "win32") chmodSync(filePath, 0o600);
  return fd;
}

export class RedactingLineTransform extends Transform {
  constructor(options = {}) {
    super(options);
    this.pending = Buffer.alloc(0);
  }

  pushLine(line) {
    const original = line.toString("utf8");
    const redacted = redactCredentialText(original);
    this.push(redacted === original ? line : Buffer.from(redacted, "utf8"));
  }

  _transform(chunk, encoding, callback) {
    try {
      const incoming = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk, encoding);
      const buffered = this.pending.length
        ? Buffer.concat([this.pending, incoming])
        : incoming;
      let start = 0;
      let newline = buffered.indexOf(0x0a, start);
      while (newline !== -1) {
        this.pushLine(buffered.subarray(start, newline + 1));
        start = newline + 1;
        newline = buffered.indexOf(0x0a, start);
      }
      this.pending = start < buffered.length
        ? Buffer.from(buffered.subarray(start))
        : Buffer.alloc(0);
      callback();
    } catch (error) {
      callback(error);
    }
  }

  _flush(callback) {
    try {
      if (this.pending.length) this.pushLine(this.pending);
      this.pending = Buffer.alloc(0);
      callback();
    } catch (error) {
      callback(error);
    }
  }
}

export function installProcessOutputRedaction({
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const installed = [];
  for (const stream of new Set([stdout, stderr])) {
    if (!stream || typeof stream.write !== "function") continue;
    const originalWrite = stream.write;
    const writeOriginal = originalWrite.bind(stream);
    const redactor = new RedactingLineTransform();
    redactor.on("data", (chunk) => writeOriginal(chunk));
    stream.write = (...args) => redactor.write(...args);
    installed.push({ originalWrite, redactor, stream });
  }
  let flushed = false;
  return Object.freeze({
    flush() {
      if (flushed) return;
      flushed = true;
      for (const { redactor } of installed) redactor.end();
    },
    restore() {
      for (const { originalWrite, stream } of installed) {
        stream.write = originalWrite;
      }
    },
  });
}
