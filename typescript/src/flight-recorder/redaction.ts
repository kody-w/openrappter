import { createHash } from "node:crypto";
import type { FlightRecorderPrivacy } from "./types.js";

const REDACTED = "[redacted]";
const EXCLUDED_PATH = "[excluded-path]";
const CIRCULAR = "[circular]";
const UNSERIALIZABLE = "[unserializable]";
const DEFAULT_MAX_PAYLOAD_BYTES = 16 * 1024;
const MAX_SANITIZE_STRING_BYTES = 64 * 1024;
const MAX_EMBEDDED_JSON_PARSE_CHARS = MAX_SANITIZE_STRING_BYTES * 4;
const MAX_EMBEDDED_JSON_DEPTH = 4;
const MAX_SANITIZE_NODES = 10_000;
const MAX_SANITIZE_BYTES = 256 * 1024;
const TRAVERSAL_LIMIT = "[truncated:budget]";

export const DEFAULT_REDACTED_KEYS: ReadonlySet<string> = new Set([
  "token",
  "secret",
  "password",
  "credential",
  "authorization",
  "api_key",
  "apiKey",
  "apikey",
  "private_key",
  "privateKey",
  "privatekey",
  "cookie",
  "session_token",
  "sessionToken",
  "sessiontoken",
  "access_token",
  "accessToken",
  "accesstoken",
  "refresh_token",
  "refreshToken",
  "refreshtoken",
  "identityKey",
  "identity_key",
  "OPENRAPPTER_FLIGHT_ID_KEY",
  "__proto__",
  "constructor",
  "prototype",
]);

export const DEFAULT_EXCLUDED_PATH_PATTERNS: readonly RegExp[] = [
  /(?:^|[\\/])\.env(?:\.[^\\/]+)?(?:$|[\\/])/i,
  /(?:^|[\\/])(?:\.git-credentials|credentials?|application_default_credentials|service[-_.]?account|client[-_.]?secret)(?:\.[^\\/]*)?$/i,
  /\.(?:pem|key|p12)(?:$|[?#])/i,
  /(?:^|[\\/])\.ssh(?:[\\/]|$)/i,
  /(?:^|[\\/])\.aws[\\/]credentials(?:$|[\\/])/i,
  /(?:^|[\\/])\.copilot_token(?:$|[\\/])/i,
  /\.identity-key(?:\.\d+\.[0-9a-f-]+\.tmp)?(?:$|[?#])/i,
];

const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})\b/i,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]*:[^@\s/]+@/i,
  /\b(?:password|pwd)\s*=\s*[^;\s]+/i,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|credential)\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{8,}/i,
  /[?&](?:token|secret|password|credential|authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret)=/i,
  // `key` and `sig` are credentials in a query string too, and the first is
  // not hypothetical: the shipped Gemini provider builds
  // `…:generateContent?key=<apiKey>`, so a recorded value carrying that URL
  // wrote the key into the ledger. Guarded by a value length so an ordinary
  // `?key=name` is left alone.
  /[?&](?:key|sig|signature)=[A-Za-z0-9._~+/=-]{8,}/i,
  /(?:^|[{,\s])["']?(?:password|pwd|token|secret|credential|authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret)["']?\s*[:=]/i,
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i,
];

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function normalizeUnicodeScalars(value: string): string {
  let normalized = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        normalized += value[index] + value[index + 1];
        index += 1;
      } else {
        normalized += "\ufffd";
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      normalized += "\ufffd";
    } else {
      normalized += value[index];
    }
  }
  return normalized;
}

function isPrototypePollutionKey(key: string): boolean {
  if (key === "__proto__") return true;
  const normalized = normalizedKey(key);
  return normalized === "constructor" || normalized === "prototype";
}

function isSensitiveKey(key: string, privacy?: FlightRecorderPrivacy): boolean {
  if (isPrototypePollutionKey(key)) return true;

  const normalized = normalizedKey(key);
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (
    words.some(
      (word) =>
        word === "token" ||
        word === "secret" ||
        word.startsWith("password") ||
        word.startsWith("credential") ||
        word === "authorization" ||
        word.startsWith("cookie"),
    )
  ) {
    return true;
  }

  if (
    [
      "apikey",
      "privatekey",
      "sessiontoken",
      "accesstoken",
      "refreshtoken",
      "identitykey",
    ].some((candidate) => normalized.includes(candidate))
  ) {
    return true;
  }

  return (privacy?.redactedKeys ?? []).some(
    (candidate) => normalizedKey(candidate) === normalized,
  );
}

function testPattern(pattern: RegExp, value: string): boolean {
  pattern.lastIndex = 0;
  const matched = pattern.test(value);
  pattern.lastIndex = 0;
  return matched;
}

function decodeValidPercentEscapes(value: string): string {
  let current = value;
  for (let pass = 0; pass < 32; pass += 1) {
    const decoded = current.replace(/(?:%[0-9a-f]{2})+/gi, (encoded) => {
      try {
        return decodeURIComponent(encoded);
      } catch {
        return new TextDecoder().decode(
          Uint8Array.from(
            [...encoded.matchAll(/%([0-9a-f]{2})/gi)],
            (match) => Number.parseInt(match[1], 16),
          ),
        );
      }
    });
    if (decoded === current) return decoded;
    current = decoded;
  }
  return REDACTED;
}

export function isExcludedFlightPath(
  value: string,
  privacy?: FlightRecorderPrivacy,
): boolean {
  const patterns = [
    ...DEFAULT_EXCLUDED_PATH_PATTERNS,
    ...(privacy?.excludedPathPatterns ?? []),
  ];
  const candidates = new Set<string>([
    value,
    value.replace(/[?#].*$/, ""),
    decodeValidPercentEscapes(value),
    decodeValidPercentEscapes(value).replace(/[?#].*$/, ""),
  ]);
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    try {
      const url = new URL(value);
      const pathname = decodeValidPercentEscapes(url.pathname);
      candidates.add(pathname);
      candidates.add(pathname.replace(/[?#].*$/, ""));
    } catch {
      try {
        candidates.add(
          decodeValidPercentEscapes(
            value.replace(/^[a-z][a-z0-9+.-]*:\/\//i, ""),
          ),
        );
      } catch {
        // Malformed percent encoding remains covered by the raw candidate.
      }
    }
  }
  return [...candidates].some((candidate) =>
    patterns.some((pattern) => testPattern(pattern, candidate)),
  );
}

function isSecretShapedString(
  value: string,
  privacy?: FlightRecorderPrivacy,
): boolean {
  const candidates = new Set([
    value,
    decodeValidPercentEscapes(value),
  ]);
  return [...candidates].some(
    (candidateValue) =>
      candidateValue === REDACTED ||
      uriHasSensitiveQueryKey(candidateValue, privacy) ||
      (privacy?.redactedValues ?? []).some(
        (candidate) =>
          candidate.length > 0 &&
          (/^[0-9a-f]{64}$/i.test(candidate)
            ? candidateValue
                .toLowerCase()
                .includes(candidate.toLowerCase())
            : candidateValue.includes(candidate)),
      ) ||
      SECRET_VALUE_PATTERNS.some((pattern) =>
        testPattern(pattern, candidateValue),
      ),
  );
}

function uriHasSensitiveQueryKey(
  value: string,
  privacy?: FlightRecorderPrivacy,
): boolean {
  if (!value.includes("?") && !value.includes("#")) return false;
  try {
    const url = new URL(value, "https://openrappter.invalid");
    const keys = [...url.searchParams.keys()];
    const fragment = decodeValidPercentEscapes(
      url.hash.replace(/^#/, ""),
    );
    if (fragment) {
      keys.push(...new URLSearchParams(fragment).keys());
    }
    for (const key of keys) {
      if (isSensitiveKey(decodeValidPercentEscapes(key), privacy))
        return true;
    }
  } catch {
    return false;
  }
  return false;
}

function isSecretShapedKey(
  value: string,
  privacy?: FlightRecorderPrivacy,
): boolean {
  return (
    (privacy?.redactedValues ?? []).some(
      (candidate) =>
        candidate.length > 0 &&
        (/^[0-9a-f]{64}$/i.test(candidate)
          ? value.toLowerCase().includes(candidate.toLowerCase())
          : value.includes(candidate)),
    ) ||
    SECRET_VALUE_PATTERNS.some((pattern) => testPattern(pattern, value))
  );
}

function flightPathString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value instanceof URL) return value.toString();
  return undefined;
}

function isFileLocatorKey(key: string): boolean {
  const normalized = normalizedKey(decodeValidPercentEscapes(key));
  return [
    "path",
    "sourcepath",
    "file",
    "filename",
    "filepath",
    "name",
    "uri",
    "url",
  ].includes(normalized) ||
    normalized.endsWith("path") ||
    normalized.endsWith("uri") ||
    normalized.endsWith("url") ||
    normalized.endsWith("filename");
}

function containsExcludedFileLocator(
  value: unknown,
  privacy?: FlightRecorderPrivacy,
  ancestors = new WeakSet<object>(),
  depth = 0,
): boolean {
  if (
    value === null ||
    typeof value !== "object" ||
    depth > 16 ||
    ancestors.has(value)
  ) {
    return depth > 16;
  }

  ancestors.add(value);
  try {
    if (value instanceof Map) {
      for (const [key, entryValue] of value) {
        if (
          typeof key === "string" &&
          isFileLocatorKey(key) &&
          flightPathString(entryValue) !== undefined &&
          isExcludedFlightPath(flightPathString(entryValue)!, privacy)
        ) return true;
        if (
          containsExcludedFileLocator(
            entryValue,
            privacy,
            ancestors,
            depth + 1,
          )
        ) return true;
      }
      return false;
    }
    if (Array.isArray(value) || value instanceof Set) {
      for (const entry of value) {
        if (
          containsExcludedFileLocator(
            entry,
            privacy,
            ancestors,
            depth + 1,
          )
        ) return true;
      }
      return false;
    }
    for (const [key, entryValue] of Object.entries(value)) {
      if (
        isFileLocatorKey(key) &&
        flightPathString(entryValue) !== undefined &&
        isExcludedFlightPath(flightPathString(entryValue)!, privacy)
      ) return true;
      if (
        containsExcludedFileLocator(
          entryValue,
          privacy,
          ancestors,
          depth + 1,
        )
      ) return true;
    }
    return false;
  } finally {
    ancestors.delete(value);
  }
}

function isSafeFileMetadataField(
  key: string,
  value: unknown,
  privacy?: FlightRecorderPrivacy,
): boolean {
  const normalized = normalizedKey(key);
  if (["size", "length"].includes(normalized)) {
    return (
      typeof value === "number" &&
      Number.isFinite(value) &&
      value >= 0
    );
  }
  if (
    ["language", "mime", "mimetype", "extension"].includes(normalized)
  ) {
    return (
      typeof value === "string" &&
      value.length <= 256 &&
      sanitizeString(value, privacy) === value
    );
  }
  return false;
}

function stableJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

function compareStableJson(left: unknown, right: unknown): number {
  const leftJson = stableJson(left);
  const rightJson = stableJson(right);
  return leftJson < rightJson ? -1 : leftJson > rightJson ? 1 : 0;
}

interface TraversalLimits {
  maxNodes: number;
  maxBytes: number;
}

const SNAPSHOT_LIMIT = Symbol("snapshot-limit");

function snapshotForSanitization(
  value: unknown,
  limits: TraversalLimits,
): unknown {
  const seen = new WeakMap<object, unknown>();
  let nodes = 0;
  let bytes = 0;

  const visit = (current: unknown): unknown => {
    nodes += 1;
    if (nodes > limits.maxNodes) throw SNAPSHOT_LIMIT;
    if (typeof current === "string") {
      bytes += Buffer.byteLength(current, "utf8");
      if (bytes > limits.maxBytes) throw SNAPSHOT_LIMIT;
      return current;
    }
    if (
      current === null ||
      (typeof current !== "object" && typeof current !== "function")
    ) {
      return current;
    }
    const prior = seen.get(current);
    if (prior !== undefined) return prior;

    if (current instanceof Date) return new Date(current.getTime());
    if (current instanceof RegExp)
      return new RegExp(current.source, current.flags);
    if (current instanceof URL) return current.toString();
    if (current instanceof ArrayBuffer) {
      bytes += current.byteLength;
      if (bytes > limits.maxBytes) throw SNAPSHOT_LIMIT;
      return current.slice(0);
    }
    if (ArrayBuffer.isView(current)) {
      bytes += current.byteLength;
      if (bytes > limits.maxBytes) throw SNAPSHOT_LIMIT;
      return sanitizeTypedArray(current);
    }
    if (Array.isArray(current)) {
      if (nodes + current.length > limits.maxNodes) throw SNAPSHOT_LIMIT;
      const clone: unknown[] = [];
      seen.set(current, clone);
      for (let index = 0; index < current.length; index += 1) {
        clone.push(visit(current[index]));
      }
      return clone;
    }
    if (current instanceof Map) {
      if (nodes + current.size * 2 > limits.maxNodes) throw SNAPSHOT_LIMIT;
      const clone = new Map<unknown, unknown>();
      seen.set(current, clone);
      for (const [key, entryValue] of current) {
        clone.set(visit(key), visit(entryValue));
      }
      return clone;
    }
    if (current instanceof Set) {
      if (nodes + current.size > limits.maxNodes) throw SNAPSHOT_LIMIT;
      const clone = new Set<unknown>();
      seen.set(current, clone);
      for (const entry of current) clone.add(visit(entry));
      return clone;
    }
    if (current instanceof Error) {
      const clone: Record<string, unknown> = Object.create(null);
      seen.set(current, clone);
      for (const key of ["name", "message", "stack", "code", "cause"]) {
        try {
          const entry = (current as unknown as Record<string, unknown>)[key];
          if (entry !== undefined) clone[key] = visit(entry);
        } catch {
          clone[key] = UNSERIALIZABLE;
        }
      }
      return clone;
    }

    const clone: Record<string, unknown> = Object.create(null);
    seen.set(current, clone);
    let keys: string[];
    try {
      keys = Object.keys(current);
    } catch {
      return UNSERIALIZABLE;
    }
    if (nodes + keys.length > limits.maxNodes) throw SNAPSHOT_LIMIT;
    for (const key of keys) {
      nodes += 1;
      bytes += Buffer.byteLength(key, "utf8");
      if (nodes > limits.maxNodes || bytes > limits.maxBytes) {
        throw SNAPSHOT_LIMIT;
      }
      try {
        clone[key] = visit(
          (current as Record<string, unknown>)[key],
        );
      } catch (error) {
        if (error === SNAPSHOT_LIMIT) throw error;
        clone[key] = UNSERIALIZABLE;
      }
    }
    return clone;
  };

  return visit(value);
}

function isWithinTraversalBudget(
  value: unknown,
  limits: TraversalLimits,
): boolean {
  const stack: Array<
    | { value: unknown }
    | { exit: object }
  > = [{ value }];
  const ancestors = new WeakSet<object>();
  let nodes = 0;
  let bytes = 0;

  while (stack.length > 0) {
    const frame = stack.pop()!;
    if ("exit" in frame) {
      ancestors.delete(frame.exit);
      continue;
    }
    const current = frame.value;
    nodes += 1;
    if (nodes > limits.maxNodes) return false;
    if (typeof current === "string") {
      bytes += Buffer.byteLength(current, "utf8");
      if (bytes > limits.maxBytes) return false;
      continue;
    }
    if (
      current === null ||
      (typeof current !== "object" && typeof current !== "function")
    ) {
      continue;
    }
    if (current instanceof ArrayBuffer) {
      bytes += current.byteLength;
      if (bytes > limits.maxBytes) return false;
      continue;
    }
    if (ArrayBuffer.isView(current)) {
      bytes += current.byteLength;
      if (bytes > limits.maxBytes) return false;
      continue;
    }
    if (ancestors.has(current)) continue;
    ancestors.add(current);
    stack.push({ exit: current });

    if (Array.isArray(current)) {
      if (current.length + nodes > limits.maxNodes) return false;
      for (let index = current.length - 1; index >= 0; index -= 1) {
        stack.push({ value: current[index] });
      }
      continue;
    }
    if (current instanceof Map) {
      if (current.size * 2 + nodes > limits.maxNodes) return false;
      for (const [key, entryValue] of current) {
        stack.push({ value: key }, { value: entryValue });
      }
      continue;
    }
    if (current instanceof Set) {
      if (current.size + nodes > limits.maxNodes) return false;
      for (const entry of current) stack.push({ value: entry });
      continue;
    }
    if (current instanceof Error) {
      for (const key of ["name", "message", "stack"] as const) {
        try {
          const entry = current[key];
          if (entry !== undefined) stack.push({ value: entry });
        } catch {
          stack.push({ value: UNSERIALIZABLE });
        }
      }
      const error = current as Error & {
        cause?: unknown;
        code?: unknown;
      };
      if ("cause" in error) stack.push({ value: error.cause });
      if ("code" in error) stack.push({ value: error.code });
      continue;
    }

    try {
      for (const key in current as Record<string, unknown>) {
        if (!Object.hasOwn(current, key)) continue;
        nodes += 1;
        bytes += Buffer.byteLength(key, "utf8");
        if (nodes > limits.maxNodes || bytes > limits.maxBytes) return false;
        stack.push({
          value: (current as Record<string, unknown>)[key],
        });
      }
    } catch {
      return true;
    }
  }
  return true;
}

function sanitizeBoundedValue(
  value: unknown,
  privacy: FlightRecorderPrivacy | undefined,
  limits: TraversalLimits,
): unknown {
  try {
    const snapshot = snapshotForSanitization(value, limits);
    if (!isWithinTraversalBudget(snapshot, limits)) return TRAVERSAL_LIMIT;
    return sanitizeRecursive(snapshot, privacy, new WeakSet());
  } catch (error) {
    if (error === SNAPSHOT_LIMIT) return TRAVERSAL_LIMIT;
    return UNSERIALIZABLE;
  }
}

interface EmbeddedJsonRange {
  kind: "container" | "string";
  start: number;
  end: number;
  children: EmbeddedJsonRange[];
}

interface EmbeddedJsonBudget {
  remaining: number;
  exhausted: boolean;
}

function oversizedStringMarker(value: string): string | undefined {
  const byteCount = Buffer.byteLength(value, "utf8");
  return byteCount > MAX_SANITIZE_STRING_BYTES
    ? `[truncated:${byteCount}]`
    : undefined;
}

function collectEmbeddedJsonRanges(value: string): EmbeddedJsonRange[] {
  const completed: EmbeddedJsonRange[] = [];
  const stack: Array<{ opening: "{" | "["; start: number }> = [];
  let stringStart = -1;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (stringStart >= 0) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        completed.push({
          kind: "string",
          start: stringStart,
          end: index,
          children: [],
        });
        stringStart = -1;
      }
      continue;
    }

    if (character === '"') {
      stringStart = index;
      continue;
    }
    if (character === "{" || character === "[") {
      stack.push({ opening: character, start: index });
      continue;
    }
    if (character !== "}" && character !== "]") continue;
    const expected = character === "}" ? "{" : "[";
    const opening = stack.at(-1);
    if (!opening || opening.opening !== expected) continue;
    stack.pop();
    completed.push({
      kind: "container",
      start: opening.start,
      end: index,
      children: [],
    });
  }

  completed.sort(
    (left, right) => left.start - right.start || right.end - left.end,
  );
  const roots: EmbeddedJsonRange[] = [];
  const parents: EmbeddedJsonRange[] = [];
  for (const range of completed) {
    while (
      parents.length > 0 &&
      !(
        parents.at(-1)!.start < range.start &&
        range.end < parents.at(-1)!.end
      )
    ) {
      parents.pop();
    }
    const parent = parents.at(-1);
    if (parent) {
      parent.children.push(range);
    } else {
      roots.push(range);
    }
    parents.push(range);
  }
  return roots;
}

function protectUnsafeJsonIntegers(value: string): string {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < value.length; ) {
    const character = value[index];
    if (inString) {
      output += character;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      index += 1;
      continue;
    }
    if (character === '"') {
      inString = true;
      output += character;
      index += 1;
      continue;
    }
    if (character === "-" || /[0-9]/.test(character)) {
      const match =
        /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(
          value.slice(index),
        );
      if (match) {
        const token = match[0];
        if (!/[.eE]/.test(token)) {
          try {
            const integer = BigInt(token);
            if (
              integer > BigInt(Number.MAX_SAFE_INTEGER) ||
              integer < BigInt(Number.MIN_SAFE_INTEGER)
            ) {
              output += JSON.stringify(`${token}n`);
              index += token.length;
              continue;
            }
          } catch {
            // Native parsing reports malformed numeric tokens.
          }
        }
        output += token;
        index += token.length;
        continue;
      }
    }
    output += character;
    index += 1;
  }
  return output;
}

function parseLosslessJson(value: string): unknown {
  return JSON.parse(protectUnsafeJsonIntegers(value));
}

function sanitizeEmbeddedJson(
  value: string,
  privacy?: FlightRecorderPrivacy,
  depth = 0,
  budget: EmbeddedJsonBudget = {
    remaining: Math.min(
      MAX_EMBEDDED_JSON_PARSE_CHARS,
      Math.max(value.length * 4, 1_024),
    ),
    exhausted: false,
  },
): string {
  const oversized = oversizedStringMarker(value);
  if (oversized) return oversized;
  if (depth > MAX_EMBEDDED_JSON_DEPTH) return REDACTED;

  const ranges = collectEmbeddedJsonRanges(value);
  const renderRange = (range: EmbeddedJsonRange): string => {
    const candidate = value.slice(range.start, range.end + 1);
    budget.remaining -= candidate.length;
    if (budget.remaining < 0) {
      budget.exhausted = true;
      return "";
    }

    try {
      const parsed = parseLosslessJson(candidate);
      if (
        range.kind === "container" &&
        parsed !== null &&
        typeof parsed === "object"
      ) {
        return (
          JSON.stringify(
            sanitizeRecursive(parsed, privacy, new WeakSet()),
          ) ?? UNSERIALIZABLE
        );
      }
      if (
        range.kind === "string" &&
        typeof parsed === "string"
      ) {
        const nested = sanitizeEmbeddedJson(
          parsed,
          privacy,
          depth + 1,
          budget,
        );
        return JSON.stringify(
          sanitizeScalarString(nested, privacy),
        );
      }
    } catch {
      // Invalid outer syntax falls through to its completed child ranges.
    }

    let rendered = "";
    let cursor = range.start;
    for (const child of range.children) {
      rendered += value.slice(cursor, child.start);
      rendered += renderRange(child);
      cursor = child.end + 1;
    }
    return rendered + value.slice(cursor, range.end + 1);
  };

  let output = "";
  let cursor = 0;
  for (const range of ranges) {
    output += value.slice(cursor, range.start);
    output += renderRange(range);
    cursor = range.end + 1;
  }
  output += value.slice(cursor);
  return budget.exhausted
    ? `[truncated:${Buffer.byteLength(value, "utf8")}]`
    : output;
}

function sanitizeString(
  value: string,
  privacy?: FlightRecorderPrivacy,
): string {
  value = normalizeUnicodeScalars(value);
  const oversized = oversizedStringMarker(value);
  if (oversized) return oversized;
  return sanitizeScalarString(
    sanitizeEmbeddedJson(value, privacy),
    privacy,
  );
}

function sanitizeScalarString(
  value: string,
  privacy?: FlightRecorderPrivacy,
): string {
  if (isExcludedFlightPath(value, privacy)) return EXCLUDED_PATH;
  if (isSecretShapedString(value, privacy)) return REDACTED;
  return value;
}

function unsafePropertyKeyMarker(
  key: string,
  privacy?: FlightRecorderPrivacy,
): string | undefined {
  key = decodeValidPercentEscapes(normalizeUnicodeScalars(key));
  if (key === REDACTED) return REDACTED;
  if (isPrototypePollutionKey(key)) return REDACTED;
  if (isSecretShapedKey(key, privacy)) return REDACTED;
  const pathLike =
    key.includes("/") ||
    key.includes("\\") ||
    key.startsWith(".") ||
    /\.[a-z0-9]+$/i.test(key) ||
    /^(?:application_default_credentials|client[-_.]?secret)$/i.test(
      key,
    );
  if (pathLike && isExcludedFlightPath(key, privacy)) return EXCLUDED_PATH;
  // Non-path field names such as `Credential` keep their useful schema key and
  // redact the value.
  if (isSensitiveKey(key, privacy)) return undefined;
  return undefined;
}

function planSanitizedPropertyKeys(
  keys: string[],
  privacy?: FlightRecorderPrivacy,
): Map<string, string> {
  const ordered = [...keys].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  const reserved = new Set(
    ordered
      .map((key) =>
        decodeValidPercentEscapes(normalizeUnicodeScalars(key)),
      )
      .filter(
        (key) => unsafePropertyKeyMarker(key, privacy) === undefined,
      ),
  );
  const assigned = new Set<string>();
  const plan = new Map<string, string>();

  for (const key of ordered) {
    const normalized = decodeValidPercentEscapes(
      normalizeUnicodeScalars(key),
    );
    const marker = unsafePropertyKeyMarker(normalized, privacy);
    if (marker === undefined && !assigned.has(normalized)) {
      plan.set(key, normalized);
      assigned.add(normalized);
      continue;
    }
    const base = marker ?? normalized;
    let candidate = base;
    let suffix = 2;
    while (reserved.has(candidate) || assigned.has(candidate)) {
      candidate = `${base}#${suffix}`;
      suffix += 1;
    }
    plan.set(key, candidate);
    assigned.add(candidate);
  }
  return plan;
}

function sanitizeTypedArray(value: ArrayBufferView): unknown[] {
  if (value instanceof DataView) {
    return Array.from(
      new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
    );
  }

  return Array.from(value as unknown as ArrayLike<number | bigint>, (entry) =>
    typeof entry === "bigint" ? `${entry}n` : entry,
  );
}

function sanitizeRecursive(
  value: unknown,
  privacy: FlightRecorderPrivacy | undefined,
  ancestors: WeakSet<object>,
): unknown {
  if (value === null) return null;

  switch (typeof value) {
    case "string": {
      const oversized = oversizedStringMarker(value);
      if (oversized) return oversized;
      const trimmed = value.trim();
      if (
        (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
        (trimmed.startsWith("[") && trimmed.endsWith("]"))
      ) {
        try {
          const parsed = parseLosslessJson(value);
          if (parsed !== null && typeof parsed === "object") {
            return sanitizeRecursive(parsed, privacy, ancestors);
          }
        } catch {
          // Invalid or truncated JSON remains a sanitized string.
        }
      }
      return sanitizeString(value, privacy);
    }
    case "number":
      if (!Number.isFinite(value)) return null;
      return Number.isInteger(value) && !Number.isSafeInteger(value)
        ? `${value}n`
        : value;
    case "boolean":
      return value;
    case "bigint":
      return `${value}n`;
    case "undefined":
      return null;
    case "function":
    case "symbol":
      return UNSERIALIZABLE;
  }

  if (ancestors.has(value)) return CIRCULAR;
  ancestors.add(value);

  try {
    if (value instanceof Date) {
      return Number.isNaN(value.getTime())
        ? "[invalid-date]"
        : value.toISOString();
    }

    if (value instanceof RegExp) return value.toString();

    if (value instanceof URL) {
      return sanitizeString(value.toString(), privacy);
    }

    if (value instanceof ArrayBuffer) {
      return Array.from(new Uint8Array(value));
    }

    if (ArrayBuffer.isView(value)) return sanitizeTypedArray(value);

    if (Array.isArray(value)) {
      return Array.from(value, (entry) =>
        sanitizeRecursive(entry, privacy, ancestors),
      );
    }

    if (value instanceof Map) {
      const fileLocator = containsExcludedFileLocator(value, privacy);
      const stringKeyPlan = planSanitizedPropertyKeys(
        Array.from(value.keys()).filter(
          (key): key is string => typeof key === "string",
        ),
        privacy,
      );
      const entries = Array.from(value.entries(), ([key, entryValue]) => {
        const classifiedKey =
          typeof key === "string"
            ? decodeValidPercentEscapes(normalizeUnicodeScalars(key))
            : undefined;
        const keyMarker =
          classifiedKey !== undefined
            ? unsafePropertyKeyMarker(classifiedKey, privacy)
            : undefined;
        const sanitizedKey =
          typeof key === "string"
            ? stringKeyPlan.get(key)!
            : sanitizeRecursive(key, privacy, ancestors);
        const sanitizedValue =
          keyMarker === EXCLUDED_PATH
            ? EXCLUDED_PATH
            : typeof key === "string" &&
                isFileLocatorKey(key) &&
                flightPathString(entryValue) !== undefined &&
                isExcludedFlightPath(flightPathString(entryValue)!, privacy)
              ? EXCLUDED_PATH
            : fileLocator &&
                typeof key === "string" &&
                !isSafeFileMetadataField(key, entryValue, privacy) &&
                !isFileLocatorKey(key) &&
                !containsExcludedFileLocator(entryValue, privacy)
              ? EXCLUDED_PATH
            : classifiedKey !== undefined &&
                isSensitiveKey(classifiedKey, privacy)
            ? REDACTED
            : sanitizeRecursive(entryValue, privacy, ancestors);
        return [sanitizedKey, sanitizedValue] as [unknown, unknown];
      });
      entries.sort((left, right) => compareStableJson(left[0], right[0]));
      return entries;
    }

    if (value instanceof Set) {
      const entries = Array.from(value, (entry) =>
        sanitizeRecursive(entry, privacy, ancestors),
      );
      entries.sort(compareStableJson);
      return entries;
    }

    if (value instanceof Error) {
      const entries: Array<[string, unknown]> = [
        ["name", sanitizeString(value.name, privacy)],
        ["message", sanitizeString(value.message, privacy)],
      ];
      if (value.stack)
        entries.push(["stack", sanitizeString(value.stack, privacy)]);
      const errorWithCause = value as Error & {
        cause?: unknown;
        code?: unknown;
      };
      if ("code" in errorWithCause) {
        entries.push([
          "code",
          sanitizeRecursive(errorWithCause.code, privacy, ancestors),
        ]);
      }
      if ("cause" in errorWithCause) {
        entries.push([
          "cause",
          sanitizeRecursive(errorWithCause.cause, privacy, ancestors),
        ]);
      }
      return Object.fromEntries(entries);
    }

    const keyPlan = planSanitizedPropertyKeys(Object.keys(value), privacy);
    const record = value as Record<string, unknown>;
    const excludedFileObject = containsExcludedFileLocator(record, privacy);
    const entries: Array<[string, unknown]> = [];
    for (const [key, sanitizedKey] of keyPlan) {
      const classifiedKey = decodeValidPercentEscapes(
        normalizeUnicodeScalars(key),
      );
      if (
        unsafePropertyKeyMarker(classifiedKey, privacy) === EXCLUDED_PATH
      ) {
        entries.push([sanitizedKey, EXCLUDED_PATH]);
        continue;
      }
      if (isSensitiveKey(classifiedKey, privacy)) {
        entries.push([sanitizedKey, REDACTED]);
        continue;
      }
      let entryValue: unknown;
      try {
        entryValue = record[key];
      } catch {
        entryValue = UNSERIALIZABLE;
      }
      const locator = isFileLocatorKey(key)
        ? flightPathString(entryValue)
        : undefined;
      if (locator !== undefined && isExcludedFlightPath(locator, privacy)) {
        entries.push([sanitizedKey, EXCLUDED_PATH]);
        continue;
      }
      if (
        excludedFileObject &&
        !isSafeFileMetadataField(key, entryValue, privacy) &&
        !isFileLocatorKey(key) &&
        !containsExcludedFileLocator(entryValue, privacy)
      ) {
        entries.push([sanitizedKey, EXCLUDED_PATH]);
        continue;
      }

      entries.push([
        sanitizedKey,
        sanitizeRecursive(entryValue, privacy, ancestors),
      ]);
    }
    return Object.fromEntries(entries);
  } finally {
    ancestors.delete(value);
  }
}

export function sanitizeFlightValue(
  value: unknown,
  privacy?: FlightRecorderPrivacy,
): unknown {
  return sanitizeBoundedValue(value, privacy, {
    maxNodes: MAX_SANITIZE_NODES,
    maxBytes: MAX_SANITIZE_BYTES,
  });
}

export function sanitizeFlightMetadata(
  metadata: Record<string, unknown> | undefined,
  privacy?: FlightRecorderPrivacy,
): Record<string, unknown> {
  if (!metadata) return {};

  const sanitized = sanitizeFlightValue(metadata, privacy);
  if (sanitized && typeof sanitized === "object" && !Array.isArray(sanitized)) {
    return sanitized as Record<string, unknown>;
  }
  return { value: sanitized };
}

function safeErrorProperty(error: unknown, key: string): unknown {
  if (
    (typeof error !== "object" || error === null) &&
    typeof error !== "function"
  ) {
    return undefined;
  }
  try {
    return (error as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function safeErrorName(error: unknown): string {
  const name = safeErrorProperty(error, "name");
  if (
    typeof name === "string" &&
    /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/.test(name) &&
    !isSecretShapedString(name) &&
    !isExcludedFlightPath(name)
  ) {
    return name;
  }
  return "Error";
}

function safeErrorCode(error: unknown): string | number | boolean | undefined {
  const code = safeErrorProperty(error, "code");
  if (typeof code === "boolean") return code;
  if (
    typeof code === "number" &&
    Number.isFinite(code) &&
    String(code).length <= 32
  ) {
    return code;
  }
  if (
    typeof code === "string" &&
    /^[A-Za-z0-9_.:-]{1,64}$/.test(code) &&
    !isSecretShapedString(code) &&
    !isExcludedFlightPath(code)
  ) {
    return code;
  }
  return undefined;
}

function safeHttpStatus(error: unknown): number | undefined {
  for (const key of ["status", "statusCode"]) {
    const status = safeErrorProperty(error, key);
    if (
      typeof status === "number" &&
      Number.isInteger(status) &&
      status >= 100 &&
      status <= 599
    ) {
      return status;
    }
  }
  return undefined;
}

export function summarizeFlightError(error: unknown): Record<string, unknown> {
  try {
    const messageValue =
      typeof error === "string" ? error : safeErrorProperty(error, "message");
    const rawMessage = typeof messageValue === "string" ? messageValue : "";
    const summary: Record<string, unknown> = {
      errorName: safeErrorName(error),
      messageHash: createHash("sha256").update(rawMessage).digest("hex"),
      messageChars: rawMessage.length,
    };

    const errorCode = safeErrorCode(error);
    if (errorCode !== undefined) summary.errorCode = errorCode;

    const httpStatus = safeHttpStatus(error);
    if (httpStatus !== undefined) summary.httpStatus = httpStatus;

    return summary;
  } catch {
    return {
      errorName: "Error",
      messageHash:
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      messageChars: 0,
    };
  }
}

export function sanitizeFlightPayload(
  payload: unknown,
  privacy?: FlightRecorderPrivacy,
): unknown | undefined {
  if (privacy?.recordIO !== true) return undefined;

  const configuredLimit = privacy.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
  const maxPayloadBytes =
    Number.isFinite(configuredLimit) && configuredLimit >= 0
      ? Math.floor(configuredLimit)
      : DEFAULT_MAX_PAYLOAD_BYTES;
  if (maxPayloadBytes < 4) return `[truncated:${maxPayloadBytes}]`;

  const resolved =
    typeof payload === "function"
      ? (payload as () => unknown)()
      : payload;
  const sanitized = sanitizeBoundedValue(resolved, privacy, {
    maxNodes: Math.max(
      64,
      Math.min(MAX_SANITIZE_NODES, maxPayloadBytes * 2 + 64),
    ),
    maxBytes: Math.max(
      MAX_SANITIZE_STRING_BYTES,
      Math.min(MAX_SANITIZE_BYTES, maxPayloadBytes * 4 + 1_024),
    ),
  });
  let serialized: string;
  try {
    const result = JSON.stringify(sanitized);
    if (result === undefined) return UNSERIALIZABLE;
    serialized = result;
  } catch {
    return UNSERIALIZABLE;
  }

  const serializedBytes = Buffer.byteLength(serialized, "utf8");

  if (serializedBytes <= maxPayloadBytes) return sanitized;
  return `[truncated:${serializedBytes}]`;
}
