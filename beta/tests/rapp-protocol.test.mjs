import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  H,
  SOURCE_COMMIT,
  buildFrame,
  canonical,
  mintRappid,
  packEgg,
  rappidValid,
  readEgg,
  verifyEgg,
  verifyFrame,
} from "../electron/rapp-protocol.mjs";


const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const vectors = JSON.parse(
  readFileSync(
    path.join(root, "tools", "rapp1", "conformance-vectors.json"),
    "utf8",
  ),
);

test("RAPP/1 authority revision is pinned", () => {
  assert.equal(SOURCE_COMMIT, vectors.source_commit);
});

test("canonicalization and domain hashes match shared vectors", () => {
  for (const vector of vectors.canonical) {
    assert.equal(canonical(vector.value), vector.bytes_utf8);
    assert.equal(H("rapp/1:particle", vector.value), vector.particle);
    assert.equal(H("rapp/1:wave", vector.value), vector.wave);
    assert.equal(
      H("rapp/1:egg-manifest", vector.value),
      vector.egg_manifest,
    );
  }
});

test("keyless identity reuses the UUID memory anchor", () => {
  const vector = vectors.identity;
  const identity = mintRappid(vector.owner, vector.slug, {
    uuidAnchor: vector.uuid_anchor,
  });
  assert.equal(identity.rappid, vector.rappid);
  assert.equal(identity.uuidAnchor, vector.uuid_anchor);
  assert.equal(rappidValid(identity.rappid), true);
});

test("frame build and verification match shared vectors", () => {
  const vector = vectors.frame;
  const frame = buildFrame({
    kind: vector.kind,
    streamId: vector.stream_id,
    seq: vector.seq,
    utc: vector.utc,
    payload: vector.payload,
    prev: vector.prev,
    prevWave: vector.prev_wave,
    sig: vector.sig,
  });
  assert.equal(frame.payload_hash, vector.payload_hash);
  assert.equal(frame.frame_hash, vector.frame_hash);
  assert.deepEqual(
    verifyFrame(frame, { streamIdOfRecord: vector.stream_id }),
    [true, null, "ok"],
  );
});

test("session eggs are canonical JSON and round-trip", () => {
  const blob = packEgg({
    variant: "session",
    rappid: vectors.identity.rappid,
    createdUtc: "2026-08-11T00:00:00.000Z",
    payload: {
      runtime: {
        session_id: "session-1",
        composition_hash: "a".repeat(64),
      },
      transcript: [{ role: "user", content: "hello" }],
    },
  });
  assert.deepEqual(verifyEgg(blob), [true, null, "ok"]);
  assert.deepEqual(readEgg(blob).files, {});
});

test("rapplication ZIP eggs are deterministic", () => {
  const vector = vectors.rapplication_egg;
  const files = Object.fromEntries(
    Object.entries(vector.files).map(([name, content]) => [
      name,
      Buffer.from(content),
    ]),
  );
  const options = {
    variant: "rapplication",
    rappid: vectors.identity.rappid,
    createdUtc: vector.created_utc,
    files,
  };
  const first = packEgg(options);
  const second = packEgg(options);
  assert.deepEqual(Buffer.from(first), Buffer.from(second));
  assert.equal(first.length, vector.size);
  assert.equal(
    createHash("sha256")
      .update(first)
      .digest("hex"),
    vector.sha256,
  );
  assert.deepEqual(verifyEgg(first), [true, null, "ok"]);
});
