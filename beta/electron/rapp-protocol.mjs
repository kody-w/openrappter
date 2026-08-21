import { createHash, randomUUID } from "node:crypto";

import {
  strFromU8,
  strToU8,
  unzipSync,
  zipSync,
} from "fflate";


export const SPEC = "rapp/1";
export const SOURCE_COMMIT =
  "d2cd5abed48d3f52b86bbb975ac3558286d1db41";
export const FRAME_KEYS = new Set([
  "spec",
  "kind",
  "stream_id",
  "seq",
  "utc",
  "payload",
  "payload_hash",
  "frame_hash",
  "prev",
  "prev_wave",
  "sig",
]);

const MAX_CANONICAL_BYTES = 1024 * 1024;
const MAX_DEPTH = 64;
const MAX_SAFE_INTEGER = 2 ** 53 - 1;
const HEX64 = /^[0-9a-f]{64}$/;
const FIXED_UTC =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:(?:[0-5]\d)\.\d{3}Z$/;
const LCLABEL = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const KIND =
  /^[a-z0-9]+(?:-[a-z0-9]+)*\.[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RAPPID =
  /^rappid:@([a-z0-9]+(?:-[a-z0-9]+)*)\/([a-z0-9]+(?:-[a-z0-9]+)*):([0-9a-f]{64})$/;
const EGG_VARIANTS = new Set([
  "runtime",
  "rapplication",
  "session",
  "invite",
  "neighborhood",
  "estate",
]);
const JSON_EGG_VARIANTS = new Set(["session", "invite"]);
const EGG_MANIFEST_KEYS = new Set([
  "schema",
  "variant",
  "rappid",
  "created_utc",
  "contents",
  "payload",
  "sig",
]);

const encoder = new TextEncoder();

function validateString(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new Error("RAPP/1 strings cannot contain unpaired surrogates");
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error("RAPP/1 strings cannot contain unpaired surrogates");
    }
  }
}

function validateValue(value, depth = 1) {
  if (depth > MAX_DEPTH) {
    throw new Error(`RAPP/1 JSON nesting exceeds ${MAX_DEPTH}`);
  }
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("RAPP/1 numbers must be finite");
    }
    if (Number.isInteger(value) && Math.abs(value) > MAX_SAFE_INTEGER) {
      throw new Error("RAPP/1 integers must round-trip through binary64");
    }
    return;
  }
  if (typeof value === "string") {
    validateString(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) validateValue(item, depth + 1);
    return;
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("RAPP/1 objects must be plain JSON objects");
    }
    for (const [key, item] of Object.entries(value)) {
      validateString(key);
      validateValue(item, depth + 1);
    }
    return;
  }
  throw new Error(`RAPP/1 value is not I-JSON: ${typeof value}`);
}

function canonicalUnchecked(value) {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalUnchecked).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalUnchecked(value[key])}`)
    .join(",")}}`;
}

export function canonical(value) {
  validateValue(value);
  const result = canonicalUnchecked(value);
  if (encoder.encode(result).byteLength > MAX_CANONICAL_BYTES) {
    throw new Error("RAPP/1 canonical form exceeds 1 MiB");
  }
  return result;
}

export function H(space, value) {
  return createHash("sha256")
    .update(space, "ascii")
    .update("\n", "ascii")
    .update(canonical(value), "utf8")
    .digest("hex");
}

export function Hb(space, octets) {
  if (!(octets instanceof Uint8Array)) {
    throw new TypeError("Hb requires Uint8Array bytes");
  }
  return createHash("sha256")
    .update(space, "ascii")
    .update("\n", "ascii")
    .update(octets)
    .digest("hex");
}

function uuidBytes(value) {
  const compact = String(value).replaceAll("-", "");
  if (!/^[0-9a-f]{32}$/i.test(compact)) {
    throw new Error("UUID anchor is invalid");
  }
  return Uint8Array.from(Buffer.from(compact, "hex"));
}

function validateOwnerSlug(owner, slug) {
  if (
    typeof owner !== "string"
    || owner.length < 1
    || owner.length > 39
    || !LCLABEL.test(owner)
  ) {
    throw new Error("RAPP/1 owner must be a lowercase GitHub-login label");
  }
  if (
    typeof slug !== "string"
    || slug.length < 1
    || slug.length > 100
    || !LCLABEL.test(slug)
  ) {
    throw new Error("RAPP/1 slug must be a lowercase label");
  }
}

export function mintRappid(
  owner,
  slug,
  {
    uuidAnchor = null,
    spkiDer = null,
  } = {},
) {
  validateOwnerSlug(owner, slug);
  if (uuidAnchor && spkiDer) {
    throw new Error("Choose keyed or keyless RAPPID minting, not both");
  }
  if (spkiDer) {
    const bytes = spkiDer instanceof Uint8Array
      ? spkiDer
      : Uint8Array.from(spkiDer);
    return {
      rappid: `rappid:@${owner}/${slug}:${Hb("rapp/1:rappid", bytes)}`,
      uuidAnchor: null,
    };
  }
  const anchor = uuidAnchor || randomUUID();
  return {
    rappid: `rappid:@${owner}/${slug}:${Hb(
      "rapp/1:rappid",
      uuidBytes(anchor),
    )}`,
    uuidAnchor: anchor,
  };
}

export function rappidValid(value) {
  const match = RAPPID.exec(value || "");
  return Boolean(
    match
    && match[1].length <= 39
    && match[2].length <= 100,
  );
}

export function buildFrame({
  kind,
  streamId,
  seq,
  utc,
  payload,
  prev,
  prevWave = null,
  sig = null,
}) {
  const frame = {
    spec: SPEC,
    kind,
    stream_id: streamId,
    seq,
    utc,
    payload,
    payload_hash: H("rapp/1:particle", payload),
    prev,
    prev_wave: prevWave,
    sig,
  };
  const preimage = Object.fromEntries(
    Object.entries(frame).filter(([key]) => !["frame_hash", "sig"].includes(key)),
  );
  return {
    ...frame,
    frame_hash: H("rapp/1:wave", preimage),
  };
}

export function verifyFrame(
  frame,
  {
    head = null,
    streamIdOfRecord = null,
  } = {},
) {
  if (
    !frame
    || typeof frame !== "object"
    || Array.isArray(frame)
    || frame instanceof Uint8Array
    || Object.keys(frame).length !== FRAME_KEYS.size
    || Object.keys(frame).some((key) => !FRAME_KEYS.has(key))
  ) {
    return [false, "1", "frame must contain exactly the 11 RAPP/1 keys"];
  }
  if (frame.spec !== SPEC) return [false, "1", "spec != rapp/1"];
  if (typeof frame.kind !== "string" || !KIND.test(frame.kind)) {
    return [false, "1", "invalid kind"];
  }
  if (typeof frame.stream_id !== "string") {
    return [false, "1", "invalid stream_id type"];
  }
  if (!Number.isSafeInteger(frame.seq) || frame.seq < 0) {
    return [false, "1", "seq is not uint53"];
  }
  if (typeof frame.utc !== "string" || !FIXED_UTC.test(frame.utc)) {
    return [false, "1", "utc is not fixed millisecond UTC"];
  }
  if (
    !frame.payload
    || typeof frame.payload !== "object"
    || Array.isArray(frame.payload)
  ) {
    return [false, "1", "payload is not an object"];
  }
  for (const field of ["payload_hash", "frame_hash"]) {
    if (typeof frame[field] !== "string" || !HEX64.test(frame[field])) {
      return [false, "1", `${field} is not lowercase 64-hex`];
    }
  }
  for (const field of ["prev", "prev_wave"]) {
    if (
      frame[field] !== null
      && (typeof frame[field] !== "string" || !HEX64.test(frame[field]))
    ) {
      return [false, "1", `${field} is not null or lowercase 64-hex`];
    }
  }
  if (streamIdOfRecord && frame.stream_id !== streamIdOfRecord) {
    return [false, "1a", "stream_id mismatch"];
  }
  try {
    if (frame.payload_hash !== H("rapp/1:particle", frame.payload)) {
      return [false, "2", "payload_hash mismatch"];
    }
    const preimage = Object.fromEntries(
      Object.entries(frame).filter(
        ([key]) => !["frame_hash", "sig"].includes(key),
      ),
    );
    if (frame.frame_hash !== H("rapp/1:wave", preimage)) {
      return [false, "3", "frame_hash mismatch"];
    }
  } catch (error) {
    return [false, "1", error.message];
  }
  if (!head) {
    if (frame.seq !== 0 || frame.prev !== null) {
      return [false, "4", "genesis must be seq=0 and prev=null"];
    }
  } else {
    if (frame.seq !== head.seq + 1) return [false, "4", "seq is not contiguous"];
    if (frame.prev !== head.payload_hash) {
      return [false, "4", "prev does not match head particle"];
    }
    if (frame.utc < head.utc) return [false, "4", "utc moved backwards"];
  }
  const swarm = frame.stream_id.startsWith("net:");
  if (swarm && frame.seq > 0) {
    if (head && frame.prev_wave !== head.frame_hash) {
      return [false, "5", "prev_wave does not match swarm head"];
    }
  } else if (frame.prev_wave !== null) {
    return [false, "5", "prev_wave must be null off swarm"];
  }
  if (swarm && frame.sig === null) {
    return [false, "6", "swarm frame must be signed"];
  }
  return [true, null, "ok"];
}

export function eggAddress(manifest) {
  return H(
    "rapp/1:egg-manifest",
    Object.fromEntries(
      Object.entries(manifest).filter(([key]) => key !== "sig"),
    ),
  );
}

function eggContents(files) {
  return Object.entries(files)
    .map(([path, bytes]) => ({
      path,
      hash: Hb("rapp/1:egg", bytes),
    }))
    .sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)));
}

export function packEgg({
  variant,
  rappid,
  createdUtc,
  files = {},
  payload = {},
  sig = null,
}) {
  if (!EGG_VARIANTS.has(variant)) throw new Error(`Unknown egg variant: ${variant}`);
  if (!rappidValid(rappid)) throw new Error("Invalid RAPPID");
  if (!FIXED_UTC.test(createdUtc)) throw new Error("Invalid createdUtc");
  const jsonVariant = JSON_EGG_VARIANTS.has(variant);
  if (jsonVariant && Object.keys(files).length) {
    throw new Error(`${variant} is a JSON egg and cannot contain files`);
  }
  const contents = jsonVariant ? [] : eggContents(files);
  const manifest = {
    schema: "rapp/1-egg",
    variant,
    rappid,
    created_utc: createdUtc,
    contents,
    payload,
    sig,
  };
  const manifestBytes = strToU8(canonical(manifest));
  if (jsonVariant) return manifestBytes;
  const date = new Date(1980, 0, 1, 0, 0, 0);
  const zipOptions = {
    level: 0,
    mtime: date,
    os: 3,
    attrs: 0x1800000,
  };
  const entries = {
    "manifest.json": [manifestBytes, zipOptions],
  };
  for (const entry of contents) {
    entries[entry.path] = [files[entry.path], zipOptions];
  }
  return zipSync(entries, { level: 0 });
}

export function readEgg(blob) {
  if (blob[0] === 0x50 && blob[1] === 0x4b) {
    const files = unzipSync(blob);
    const manifest = JSON.parse(strFromU8(files["manifest.json"]));
    delete files["manifest.json"];
    return { manifest, files };
  }
  return {
    manifest: JSON.parse(strFromU8(blob)),
    files: {},
  };
}

export function verifyEgg(blob) {
  let parsed;
  try {
    parsed = readEgg(blob);
  } catch (error) {
    return [false, "parse", error.message];
  }
  const { manifest, files } = parsed;
  if (
    !manifest
    || typeof manifest !== "object"
    || Array.isArray(manifest)
    || Object.keys(manifest).length !== EGG_MANIFEST_KEYS.size
    || Object.keys(manifest).some((key) => !EGG_MANIFEST_KEYS.has(key))
  ) {
    return [false, "9.1", "manifest must contain exactly seven members"];
  }
  if (manifest.schema !== "rapp/1-egg") return [false, "9.1", "invalid schema"];
  if (!EGG_VARIANTS.has(manifest.variant)) return [false, "9.2", "unknown variant"];
  if (!rappidValid(manifest.rappid)) return [false, "6.1", "invalid RAPPID"];
  if (!FIXED_UTC.test(manifest.created_utc)) {
    return [false, "7.4", "invalid created_utc"];
  }
  if (!Array.isArray(manifest.contents)) return [false, "9.1", "invalid contents"];
  const paths = manifest.contents.map((entry) => entry?.path);
  for (const path of paths) {
    if (
      typeof path !== "string"
      || path.startsWith("/")
      || path.includes("\\")
      || path.split("/").some((part) => ["", ".", ".."].includes(part))
    ) {
      return [false, "9.1", `invalid egg path: ${path}`];
    }
  }
  const sorted = [...paths].sort(
    (left, right) => Buffer.from(left).compare(Buffer.from(right)),
  );
  if (JSON.stringify(paths) !== JSON.stringify(sorted)) {
    return [false, "9.1", "egg paths are not byte-sorted"];
  }
  if (new Set(paths).size !== paths.length) return [false, "9.1", "duplicate path"];
  if (JSON_EGG_VARIANTS.has(manifest.variant)) {
    if (paths.length) return [false, "9.1", "JSON egg contents must be empty"];
    if (Buffer.compare(Buffer.from(blob), Buffer.from(strToU8(canonical(manifest))))) {
      return [false, "9.1", "JSON egg is not canonical"];
    }
  } else {
    if (
      JSON.stringify(Object.keys(files).sort())
      !== JSON.stringify([...paths].sort())
    ) {
      return [false, "9.1", "archive entries do not match contents"];
    }
    for (const entry of manifest.contents) {
      if (Hb("rapp/1:egg", files[entry.path]) !== entry.hash) {
        return [false, "5", `content hash mismatch: ${entry.path}`];
      }
    }
  }
  return [true, null, "ok"];
}
