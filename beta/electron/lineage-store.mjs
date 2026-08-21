import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  H,
  Hb,
  mintRappid,
  rappidValid,
} from "./rapp-protocol.mjs";


const LINEAGE_SCHEMA = "molt-lineage/1.0";
const HEAD_FILE = "HEAD";
const PRIOR_FILE = "PRIOR_HEAD";
const DEFAULT_ENV = "default";
const ENVIRONMENT_NAME = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const ATOMIC_WRITE_TEMP_SUFFIX = /(?:^|\.)\d+\.\d+\.tmp$/;
const LOCUS_FILE = "locus.json";
const RING_SOURCE_FILE = "source.py";
const RING_META_FILE = "meta.json";
const JOURNAL_CORRUPT_REASON =
  "promotion journal is corrupt — refusing to trust or extend it";
const JOURNAL_WRITE_REASON =
  "promotion journal could not record the attempt — refusing to move HEAD";

export const MAX_AGENT_BYTES = 512 * 1024;
export const MAX_PROMOTION_JOURNAL_BYTES = 512 * 1024;

function ensurePrivateDirectory(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    chmodSync(directory, 0o700);
  } catch {}
}

function atomicWrite(filePath, value) {
  ensurePrivateDirectory(path.dirname(filePath));
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, value, { mode: 0o600 });
  renameSync(temporary, filePath);
}

function atomicWriteJson(filePath, value) {
  atomicWrite(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readJsonSafe(filePath) {
  // A corrupt or unreadable JSON file is treated as absent: every lineage
  // error must degrade to a bootable composition, never propagate a throw.
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function sha256Hex(value) {
  return createHash("sha256")
    .update(String(value), "utf8")
    .digest("hex");
}

function normalizeEnvironment(value = DEFAULT_ENV) {
  const requested = (
    value
    && typeof value === "object"
    && !Array.isArray(value)
  )
    ? value.env
    : value;
  const raw = String(requested ?? DEFAULT_ENV).trim().toLowerCase();
  if (!raw || raw === DEFAULT_ENV) return DEFAULT_ENV;
  const sanitized = raw
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 32);
  return ENVIRONMENT_NAME.test(sanitized) ? sanitized : DEFAULT_ENV;
}

function disabledMutation(action, env = DEFAULT_ENV) {
  return {
    ok: false,
    disabled: true,
    refused: true,
    action,
    env: normalizeEnvironment(env),
    reason: "Molt Lineage is disabled (RAPP_MOLT_LINEAGE=0).",
  };
}

function filesystemSegment(value) {
  // Directory names are a short, stable digest of the rappid — URI-encoding
  // the full rappid (~100 chars per segment) pushes ring paths past the
  // Windows MAX_PATH limit (260). Identity stays inside locus.json/meta.json;
  // only the directory name shortens (same rappid -> same segment).
  return Hb(
    "rapp/1:lineage-segment",
    Buffer.from(String(value), "utf8"),
  ).slice(0, 32);
}

function slugFromFilename(filename) {
  const slug = path.basename(String(filename || ""))
    .replace(/_agent\.py$/i, "")
    .replace(/\.py$/i, "")
    .replaceAll("_", "-")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 94);
  return slug || "agent";
}

function uuidFromDigest(digest) {
  const compact = String(digest).slice(0, 32);
  if (!/^[0-9a-f]{32}$/.test(compact)) {
    throw new Error("A stable 128-bit digest is required for lineage minting.");
  }
  return [
    compact.slice(0, 8),
    compact.slice(8, 12),
    compact.slice(12, 16),
    compact.slice(16, 20),
    compact.slice(20),
  ].join("-");
}

function sourceSha256(source) {
  // The single identity chokepoint. CRLF canonicalizes to LF so a git
  // autocrlf checkout mints the same ancestor/ring rappids as an LF checkout
  // — the same molt has the same rappid everywhere.
  return Hb(
    "rapp/1:molt-source",
    Buffer.from(String(source).replaceAll("\r\n", "\n"), "utf8"),
  );
}

function ancestorRappidFor(filename, _source) {
  // Locus identity is the identity of the AGENT, not of one version of it.
  //
  // This once folded the baseline's content digest into the id. That made a
  // routine Grail upgrade — which changes a factory agent's bytes — mint a brand
  // new ancestor, silently deactivating every molt the user had grown and
  // orphaning their whole lineage with no error and no migration. A lineage has
  // to survive its baseline being updated; that is what having a baseline is for.
  //
  // The baseline digest is still recorded per locus and per ring as provenance
  // (see _ensureLocus and appendRing) — it just no longer defines the locus.
  // `_source` is kept in the signature for call-site compatibility.
  const anchor = uuidFromDigest(H("rapp/1:molt-ancestor", { filename }));
  return mintRappid("grail", slugFromFilename(filename), {
    uuidAnchor: anchor,
  }).rappid;
}

function ringRappidFor(ancestorRappid, parentRappid, source, filename) {
  const chainDigest = H("rapp/1:molt-ring", {
    ancestor: ancestorRappid,
    parent: parentRappid,
    src: sourceSha256(source),
  });
  return mintRappid(
    "frontier",
    `${slugFromFilename(filename)}-ring`,
    { uuidAnchor: uuidFromDigest(chainDigest) },
  ).rappid;
}

function newestFirst(left, right) {
  return String(right.createdAt || "").localeCompare(String(left.createdAt || ""))
    || right.ringRappid.localeCompare(left.ringRappid);
}

function sameResolution(left, right) {
  return Boolean(
    left
    && right
    && left.ringRappid === right.ringRappid
    && left.isBaseline === right.isBaseline
    && left.source === right.source
  );
}

export class LineageStore {
  constructor({
    brainstemDir,
    root = path.join(os.homedir(), ".rapp", "lineage"),
    enabled = true,
    now = () => new Date().toISOString(),
    onTelemetry = () => {},
  } = {}) {
    if (!brainstemDir) {
      throw new Error("LineageStore requires the pristine Brainstem directory.");
    }
    this.brainstemDir = path.resolve(brainstemDir);
    this.root = path.resolve(root);
    this.enabled = enabled !== false;
    this.now = now;
    this.onTelemetry = typeof onTelemetry === "function" ? onTelemetry : () => {};
    this.reportedBaselineDrift = new Set();
  }

  _recordTelemetry(type, details) {
    try {
      this.onTelemetry(type, details);
    } catch {}
  }

  /** Re-key loci that were stored under the old content-derived ancestor id.
   *
   *  Before locus identity became version-stable, a locus was keyed by the
   *  baseline's CONTENT — so a Grail upgrade orphaned the user's whole lineage.
   *  Any store written by that build still has directories under the old id.
   *  Rebuild them under the stable id, preserving each ring's source, verdict
   *  and metadata, and re-point HEAD. Non-destructive: the old directory is
   *  renamed aside, never deleted, so a bad migration can be inspected.
   *
   *  Runs at most once per process, and only when a legacy locus is present. */
  _migrateLegacyLoci(current) {
    if (this._migrated) return this.lastMigrationReport;
    if (!this.isEnabled()) {
      this.lastMigrationReport = {
        disabled: true,
        migrated: [],
        skipped: [],
        failed: [],
      };
      return this.lastMigrationReport;
    }
    this._migrated = true;
    const report = {
      disabled: false,
      migrated: [],
      skipped: [],
      failed: [],
    };
    let entries;
    try {
      entries = readdirSync(this.root, { withFileTypes: true });
    } catch {
      this.lastMigrationReport = report;
      return report;                       // no store yet: nothing to migrate
    }
    const wanted = new Map(current.map((b) => [b.filename, b]));
    const live = new Set(current.map((b) => filesystemSegment(b.ancestorRappid)));
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      if (live.has(entry.name)) continue;          // already on the stable id
      const legacyDir = path.join(this.root, entry.name);
      const locus = readJsonSafe(path.join(legacyDir, LOCUS_FILE));
      const baseline = locus && wanted.get(locus.filename);
      if (!baseline) continue;                     // not ours; leave it alone
      try {
       if (!this.isEnabled()) {
         report.disabled = true;
         this._migrated = false;
         break;
       }
       const legacyAncestor = locus.ancestorRappid;
       const rings = readdirSync(path.join(legacyDir, "rings"), { withFileTypes: true })
          .filter((d) => d.isDirectory() && !d.name.startsWith("."))
          .map((d) => {
            const meta = readJsonSafe(path.join(legacyDir, "rings", d.name, RING_META_FILE));
            let source = null;
            let sourceError = null;
            try {
              source = readFileSync(
                path.join(legacyDir, "rings", d.name, RING_SOURCE_FILE), "utf8");
            } catch (error) {
              sourceError = String(error?.message || error);
            }
            return meta ? { ...meta, source, sourceError } : null;
          })
          .filter(Boolean)
          .sort((l, r) => String(l.createdAt || "").localeCompare(String(r.createdAt || "")));

        let legacyHead = null;
        try {
          legacyHead = readFileSync(path.join(legacyDir, HEAD_FILE), "utf8").trim();
        } catch {}

        // Re-append dependency-first; timestamps are evidence, not ordering law.
        const resolved = new Map([[legacyAncestor, baseline.ancestorRappid]]);
        const byLegacyRappid = new Map(
          rings.map((ring) => [ring.ringRappid, ring]),
        );
        const visiting = [];
        const visitingIndexes = new Map();
        const skippedRings = new Set();
        const skipRing = (ring, error, fallback) => {
          if (skippedRings.has(ring.ringRappid)) return;
          skippedRings.add(ring.ringRappid);
          resolved.set(ring.ringRappid, fallback);
          const skipped = {
            ancestor_rappid: baseline.ancestorRappid,
            legacy_ancestor_rappid: legacyAncestor,
            ring_rappid: ring.ringRappid,
            recorded_sha: ring.sha256 || null,
            current_sha: typeof ring.source === "string"
             ? sourceSha256(ring.source)
             : null,
            reason: String(error?.message || error),
          };
          report.skipped.push(skipped);
          this._recordTelemetry("lineage-migration-skipped-ring", skipped);
        };
        const migrateRing = (legacyRingRappid) => {
          if (resolved.has(legacyRingRappid)) {
            return resolved.get(legacyRingRappid);
          }
          const ring = byLegacyRappid.get(legacyRingRappid);
          if (!ring) return baseline.ancestorRappid;
          if (visitingIndexes.has(legacyRingRappid)) {
            const cycleStart = visitingIndexes.get(legacyRingRappid);
            for (const cycleRappid of visiting.slice(cycleStart)) {
             const cycleRing = byLegacyRappid.get(cycleRappid);
             if (cycleRing) {
               skipRing(
                 cycleRing,
                 new Error("legacy ring parent cycle"),
                 baseline.ancestorRappid,
               );
             }
            }
            return baseline.ancestorRappid;
          }
          visitingIndexes.set(legacyRingRappid, visiting.length);
          visiting.push(legacyRingRappid);
          const parent = migrateRing(ring.parentRappid);
          if (skippedRings.has(legacyRingRappid)) {
            visiting.pop();
            visitingIndexes.delete(legacyRingRappid);
            return resolved.get(legacyRingRappid);
          }
          try {
            if (typeof ring.source !== "string") {
              throw new Error(
                ring.sourceError || "legacy ring source.py is unreadable",
              );
            }
            const actualSha = sourceSha256(ring.source);
            if (ring.sha256 !== actualSha) {
              throw new Error("legacy source sha256 does not match its metadata");
            }
            const minted = this.appendRing(baseline.ancestorRappid, {
              source: ring.source,
              parentRappid: parent,
              verified: ring.verified === true,
              meta: {
                ...(ring.meta || {}),
                baseline_sha256: ring.baselineSha256
                  || ring.meta?.baseline_sha256
                  || locus.sha256
                  || baseline.sha256,
                migrated_from: ring.ringRappid,
              },
            });
            resolved.set(ring.ringRappid, minted);
          } catch (error) {
            skipRing(ring, error, parent);
          }
          visiting.pop();
          visitingIndexes.delete(legacyRingRappid);
          return resolved.get(legacyRingRappid);
        };
        for (const ring of rings) {
          migrateRing(ring.ringRappid);
        }
        const newHead = migrateRing(legacyHead || legacyAncestor);
        const moved = this.setHead(
          baseline.ancestorRappid,
          newHead,
          { env: DEFAULT_ENV },
        );
        if (moved !== true) {
          if (moved?.disabled) {
            report.disabled = true;
            this._migrated = false;
          }
          throw new Error(
            moved?.reason || "Legacy lineage HEAD could not be re-pointed.",
          );
        }
        renameSync(legacyDir, path.join(this.root, `.migrated-${entry.name}`));
        report.migrated.push(baseline.ancestorRappid);
      } catch (error) {
        // A locus that will not migrate is left exactly as it was.
        report.failed.push({
          ancestorRappid: baseline.ancestorRappid,
          error: String(error?.message || error),
        });
      }
    }
    this.lastMigrationReport = report;
    return report;
  }

  baselineAncestors() {
    const agentsDirectory = path.join(this.brainstemDir, "agents");
    const list = readdirSync(agentsDirectory, { withFileTypes: true })
      .filter((entry) => (
        entry.isFile()
        && entry.name.endsWith("_agent.py")
        && !entry.name.startsWith("__")
      ))
      .map((entry) => {
        const sourcePath = path.join(agentsDirectory, entry.name);
        const source = readFileSync(sourcePath, "utf8");
        return {
          ancestorRappid: ancestorRappidFor(entry.name, source),
          filename: entry.name,
          sha256: sourceSha256(source),
          sourcePath,
        };
      })
      .sort((left, right) => left.filename.localeCompare(right.filename));
    if (!this._migrated) {
      try { this._migrateLegacyLoci(list); } catch { this._migrated = true; }
    }
    return list;
  }

  _baseline(ancestorRappid) {
    return this.baselineAncestors().find(
      (candidate) => candidate.ancestorRappid === ancestorRappid,
    ) || null;
  }

  _locusDirectory(ancestorRappid) {
    return path.join(this.root, filesystemSegment(ancestorRappid));
  }

  _ringsDirectory(ancestorRappid) {
    return path.join(this._locusDirectory(ancestorRappid), "rings");
  }

  _ringDirectory(ancestorRappid, ringRappid) {
    return path.join(
      this._ringsDirectory(ancestorRappid),
      filesystemSegment(ringRappid),
    );
  }

  _headPath(ancestorRappid, env = DEFAULT_ENV) {
   const environment = normalizeEnvironment(env);
   return path.join(
     this._locusDirectory(ancestorRappid),
     environment === DEFAULT_ENV
       ? HEAD_FILE
       : `${HEAD_FILE}.${environment}`,
   );
  }

  _priorHeadPath(ancestorRappid, env = DEFAULT_ENV) {
   const environment = normalizeEnvironment(env);
   return path.join(
     this._locusDirectory(ancestorRappid),
     environment === DEFAULT_ENV
       ? PRIOR_FILE
       : `${PRIOR_FILE}.${environment}`,
   );
  }

  /** The generation a rollback displaced, so `restore` can be the true inverse
   *  of `baseline` rather than a fast-forward to whatever is newest. */
  _readPriorHead(ancestorRappid, env = DEFAULT_ENV) {
   try {
     const value = readFileSync(
       this._priorHeadPath(ancestorRappid, env),
       "utf8",
     ).trim();
     return rappidValid(value) ? value : null;
   } catch {
     return null;
    }
  }

  _ensureLocus(baseline, policy = "mutable") {
    const locusDirectory = this._locusDirectory(baseline.ancestorRappid);
    ensurePrivateDirectory(this._ringsDirectory(baseline.ancestorRappid));
    const locusPath = path.join(locusDirectory, LOCUS_FILE);
    if (!existsSync(locusPath)) {
      atomicWriteJson(locusPath, {
        schema: LINEAGE_SCHEMA,
        ancestorRappid: baseline.ancestorRappid,
        filename: baseline.filename,
        sha256: baseline.sha256,
        sourcePath: baseline.sourcePath,
        policy: policy === "pinned" ? "pinned" : "mutable",
      });
    }
  }

  _readRing(ancestorRappid, ringRappid) {
    const ringDirectory = this._ringDirectory(ancestorRappid, ringRappid);
    const sourcePath = path.join(ringDirectory, RING_SOURCE_FILE);
    const metaPath = path.join(ringDirectory, RING_META_FILE);
    if (!existsSync(sourcePath) || !existsSync(metaPath)) return null;
    const meta = readJsonSafe(metaPath);
    if (!meta || typeof meta !== "object") return null;
    try {
      return {
        ...meta,
        source: readFileSync(sourcePath, "utf8"),
      };
    } catch {
      return null;
    }
  }

  _ringIsValid(ancestorRappid, ringRappid, ring = null) {
    const candidate = ring || this._readRing(ancestorRappid, ringRappid);
    if (
      !candidate
      || candidate.ringRappid !== ringRappid
      || candidate.ancestorRappid !== ancestorRappid
      || typeof candidate.source !== "string"
      || candidate.sha256 !== sourceSha256(candidate.source)
    ) {
      return false;
    }
    const baseline = this._baseline(ancestorRappid);
    if (!baseline) return false;
    return ringRappidFor(
      ancestorRappid,
      candidate.parentRappid,
      candidate.source,
      baseline.filename,
    ) === ringRappid;
  }

  _pathIsValid(ancestorRappid, ringRappid, { requireVerified = false } = {}) {
    const seen = new Set();
    let current = ringRappid;
    while (current !== ancestorRappid) {
      if (!rappidValid(current) || seen.has(current)) return false;
      seen.add(current);
      const ring = this._readRing(ancestorRappid, current);
      if (!this._ringIsValid(ancestorRappid, current, ring)) return false;
      if (requireVerified && ring.verified !== true) return false;
      current = ring.parentRappid;
    }
    return true;
  }

  listRings(ancestorRappid) {
    const baseline = this._baseline(ancestorRappid);
    if (!baseline) return [];
    const baselineRing = {
      ringRappid: ancestorRappid,
      parentRappid: null,
      ancestorRappid,
      sha256: baseline.sha256,
      verified: true,
      meta: { ring: 0, policy: "pinned", sourcePath: baseline.sourcePath },
      createdAt: null,
    };
    const ringsDirectory = this._ringsDirectory(ancestorRappid);
    if (!existsSync(ringsDirectory)) return [baselineRing];
    const rings = readdirSync(ringsDirectory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => readJsonSafe(
        path.join(ringsDirectory, entry.name, RING_META_FILE),
      ))
      .filter((meta) => meta && typeof meta.ringRappid === "string")
      .sort((left, right) => (
        String(left.createdAt || "").localeCompare(String(right.createdAt || ""))
        || left.ringRappid.localeCompare(right.ringRappid)
      ));
    return [baselineRing, ...rings];
  }

  /** Return the verified ancestry from the Grail baseline through `ringRappid`. */
  walk(ancestorRappid, ringRappid) {
    if (!this._baseline(ancestorRappid)) return [];
    if (!ringRappid || ringRappid === ancestorRappid) {
      return ringRappid === ancestorRappid ? [ancestorRappid] : [];
    }
    if (!this._pathIsValid(
      ancestorRappid,
      ringRappid,
      { requireVerified: true },
    )) {
      return [];
    }
    const chain = [];
    let current = ringRappid;
    while (current !== ancestorRappid) {
      chain.unshift(current);
      current = this._readRing(ancestorRappid, current).parentRappid;
    }
    chain.unshift(ancestorRappid);
    return chain;
  }

  appendRing(
    ancestorRappid,
    {
      source,
      parentRappid,
      verified,
      meta = {},
    } = {},
  ) {
    const baseline = this._baseline(ancestorRappid);
    if (!baseline) throw new Error(`Unknown Grail ancestor: ${ancestorRappid}`);
    if (typeof source !== "string" || !source.length) {
      throw new Error("A molt ring requires non-empty Python source.");
    }
    if (Buffer.byteLength(source, "utf8") > MAX_AGENT_BYTES) {
      throw new Error("A molt ring exceeds the agent size limit.");
    }
    const parent = parentRappid || this.getHead(ancestorRappid);
    if (
      parent !== ancestorRappid
      && !this._pathIsValid(
        ancestorRappid,
        parent,
        { requireVerified: true },
      )
    ) {
      throw new Error("A molt ring must descend from an existing valid parent.");
    }
    const ringRappid = ringRappidFor(
      ancestorRappid,
      parent,
      source,
      baseline.filename,
    );
    const ringDirectory = this._ringDirectory(ancestorRappid, ringRappid);
    if (existsSync(ringDirectory)) {
      const existing = this._readRing(ancestorRappid, ringRappid);
      if (!this._ringIsValid(ancestorRappid, ringRappid, existing)) {
        throw new Error(`Existing ring is corrupt: ${ringRappid}`);
      }
      if (verified === true && existing.verified !== true) {
        const { source: _source, ...existingMeta } = existing;
        atomicWriteJson(path.join(ringDirectory, RING_META_FILE), {
          ...existingMeta,
          verified: true,
          meta: {
            ...(existing.meta && typeof existing.meta === "object"
              ? existing.meta
              : {}),
            ...(meta && typeof meta === "object" ? meta : {}),
          },
        });
      }
      return ringRappid;
    }

    this._ensureLocus(baseline, meta.policy);
    const stagingDirectory = path.join(
      this._ringsDirectory(ancestorRappid),
      `.${filesystemSegment(ringRappid)}.${process.pid}.${Date.now()}.stage`,
    );
    ensurePrivateDirectory(stagingDirectory);
    const ringMeta = {
      schema: LINEAGE_SCHEMA,
      ringRappid,
      parentRappid: parent,
      ancestorRappid,
      sha256: sourceSha256(source),
      baselineSha256: baseline.sha256,
      verified: verified === true,
      meta: meta && typeof meta === "object" ? { ...meta } : {},
      createdAt: this.now(),
    };
    try {
      writeFileSync(
        path.join(stagingDirectory, RING_SOURCE_FILE),
        source,
        { mode: 0o600 },
      );
      writeFileSync(
        path.join(stagingDirectory, RING_META_FILE),
        `${JSON.stringify(ringMeta, null, 2)}\n`,
        { mode: 0o600 },
      );
      renameSync(stagingDirectory, ringDirectory);
    } catch (error) {
      rmSync(stagingDirectory, { recursive: true, force: true });
      if (
        existsSync(ringDirectory)
        && this._ringIsValid(ancestorRappid, ringRappid)
      ) {
        return ringRappid;
      }
      throw error;
    }
    return ringRappid;
  }

  getHead(ancestorRappid, env = DEFAULT_ENV) {
    const baseline = this._baseline(ancestorRappid);
    if (!baseline) return null;
    const headPath = this._headPath(ancestorRappid, env);
    if (!existsSync(headPath)) return ancestorRappid;
    try {
      const head = readFileSync(headPath, "utf8").trim();
      return rappidValid(head) ? head : ancestorRappid;
    } catch {
      return ancestorRappid;
    }
  }

  head(ancestorRappid, env = DEFAULT_ENV) {
    return this.getHead(ancestorRappid, env);
  }

  environments(ancestorRappid) {
    if (!this._baseline(ancestorRappid)) return [];
    const names = new Set([DEFAULT_ENV]);
    const locusDirectory = this._locusDirectory(ancestorRappid);
    try {
      for (const entry of readdirSync(locusDirectory, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.startsWith(`${HEAD_FILE}.`)) continue;
        const requested = entry.name.slice(HEAD_FILE.length + 1);
        if (
          requested !== DEFAULT_ENV
          && ENVIRONMENT_NAME.test(requested)
          && !ATOMIC_WRITE_TEMP_SUFFIX.test(requested)
          && normalizeEnvironment(requested) === requested
        ) {
          names.add(requested);
        }
      }
    } catch {}
    return [...names]
      .sort((left, right) => (
        left === DEFAULT_ENV ? -1
          : right === DEFAULT_ENV ? 1
            : left.localeCompare(right)
      ))
      .map((env) => {
        const head = this.getHead(ancestorRappid, { env });
        return {
          env,
          head,
          isBaseline: head === ancestorRappid,
        };
      });
  }

  /** Per-locus molt policy. "pinned" means this agent locus never leaves its
   *  Grail baseline however many rings exist — the user's memory agent can be
   *  frozen at ring 0 while a news agent molts daily. Defaults to "mutable". */
  locusPolicy(ancestorRappid) {
    const locus = readJsonSafe(
      path.join(this._locusDirectory(ancestorRappid), LOCUS_FILE),
    );
    return locus?.policy === "pinned" ? "pinned" : "mutable";
  }

  setLocusPolicy(ancestorRappid, policy) {
    if (!this.isEnabled()) {
      return disabledMutation("setLocusPolicy", DEFAULT_ENV);
    }
    const baseline = this._baseline(ancestorRappid);
    if (!baseline) throw new Error(`Unknown Grail ancestor: ${ancestorRappid}`);
    const next = policy === "pinned" ? "pinned" : "mutable";
    const environments = this.environments(ancestorRappid)
      .map((entry) => entry.env);
    this._ensureLocus(baseline, next);
    const locusPath = path.join(
      this._locusDirectory(ancestorRappid),
      LOCUS_FILE,
    );
    const locus = readJsonSafe(locusPath) || {
      schema: LINEAGE_SCHEMA,
      ancestorRappid,
      filename: baseline.filename,
      sha256: baseline.sha256,
      sourcePath: baseline.sourcePath,
    };
    atomicWriteJson(locusPath, { ...locus, policy: next });
    // Pinning is only meaningful if it takes effect now in every environment,
    // not at the next molt or only in the currently active environment.
    if (next === "pinned") {
      for (const env of environments) {
        const moved = this.setHead(ancestorRappid, ancestorRappid, { env });
        if (moved !== true) {
          throw new Error(
            moved?.reason || `Could not pin ${env} to the Grail baseline.`,
          );
        }
      }
    }
    return next;
  }

  setHead(ancestorRappid, ringRappid, env = DEFAULT_ENV) {
    const environment = normalizeEnvironment(env);
    if (!this.isEnabled()) {
      return disabledMutation("setHead", environment);
    }
    const baseline = this._baseline(ancestorRappid);
    if (!baseline) throw new Error(`Unknown Grail ancestor: ${ancestorRappid}`);
    if (
      ringRappid !== ancestorRappid
      && this.locusPolicy(ancestorRappid) === "pinned"
    ) {
      throw new Error(
        `Refusing to molt a pinned locus: ${baseline.filename} is pinned to its Grail baseline.`,
      );
    }
    if (
      ringRappid !== ancestorRappid
      && !this._pathIsValid(
        ancestorRappid,
        ringRappid,
        { requireVerified: true },
      )
    ) {
      throw new Error(`Refusing invalid or unverified molt ring: ${ringRappid}`);
    }
    this._ensureLocus(baseline);
    const headPath = this._headPath(ancestorRappid, environment);
    const priorPath = this._priorHeadPath(ancestorRappid, environment);
    atomicWrite(headPath, `${ringRappid}\n`);
    if (ringRappid !== ancestorRappid) {
      try {
        rmSync(priorPath, { recursive: true, force: true });
      } catch (error) {
        this._recordTelemetry("lineage-prior-cleanup-failed", {
          ancestor: ancestorRappid,
          env: environment,
          error: String(error?.message || error),
        });
      }
    }
    return true;
  }

  resolveRing(ancestorRappid, ringRappid) {
    const baseline = this._baseline(ancestorRappid);
    if (!baseline) return null;
    const baselineResult = () => ({
      ringRappid: ancestorRappid,
      source: readFileSync(baseline.sourcePath, "utf8"),
      isBaseline: true,
    });
    if (!this.enabled || process.env.RAPP_MOLT_LINEAGE === "0") {
      return baselineResult();
    }
    // A pinned locus never leaves its baseline, whatever HEAD says.
    try {
      if (this.locusPolicy(ancestorRappid) === "pinned") return baselineResult();
    } catch {}
    try {
      if (!ringRappid || ringRappid === ancestorRappid) return baselineResult();
      const ring = this._readRing(ancestorRappid, ringRappid);
      if (
        !ring
        || ring.verified !== true
        || !this._pathIsValid(
          ancestorRappid,
          ringRappid,
          { requireVerified: true },
        )
      ) {
        return baselineResult();
      }
      const drift = this.baselineDrift(ancestorRappid, { ringRappid });
      if (drift.drifted && ring.meta?.author === "frontier") {
        return baselineResult();
      }
      return {
        ringRappid,
        source: ring.source,
        isBaseline: false,
      };
    } catch {
      return baselineResult();
    }
  }

  resolveLive(ancestorRappid, env = DEFAULT_ENV) {
    return this.resolveRing(
      ancestorRappid,
      this.getHead(ancestorRappid, env),
    );
  }

  baselineDrift(
    ancestorRappid,
    { env = DEFAULT_ENV, ringRappid = null } = {},
  ) {
    const baseline = this._baseline(ancestorRappid);
    const selectedRing = ringRappid || this.getHead(ancestorRappid, { env });
    const result = {
      ancestorRappid,
      ringRappid: selectedRing,
      recordedSha: null,
      currentSha: baseline?.sha256 || null,
      drifted: false,
    };
    if (
      !baseline
      || !selectedRing
      || selectedRing === ancestorRappid
    ) {
      return result;
    }
    const ring = this._readRing(ancestorRappid, selectedRing);
    if (!this._ringIsValid(ancestorRappid, selectedRing, ring)) return result;
    const locus = readJsonSafe(
      path.join(this._locusDirectory(ancestorRappid), LOCUS_FILE),
    );
    const recordedSha = ring.meta?.baseline_sha256
      || ring.baselineSha256
      || locus?.sha256
      || null;
    result.recordedSha = recordedSha;
    result.drifted = Boolean(recordedSha && recordedSha !== baseline.sha256);
    if (result.drifted) {
      const key = [
        ancestorRappid,
        selectedRing,
        recordedSha,
        baseline.sha256,
      ].join("\0");
      if (!this.reportedBaselineDrift.has(key)) {
        this.reportedBaselineDrift.add(key);
        this._recordTelemetry("lineage-baseline-drift", {
          ancestor: ancestorRappid,
          ring: selectedRing,
          recorded_sha: recordedSha,
          current_sha: baseline.sha256,
        });
      }
    }
    return result;
  }

  /** True when the overlay may serve or move rings at all. The kill switch must
   *  gate WRITES as well as reads: otherwise HEADs move invisibly while the layer
   *  is off and silently activate on the next boot once the flag is cleared. */
  isEnabled() {
    return this.enabled && process.env.RAPP_MOLT_LINEAGE !== "0";
  }

  /** Resolve the loci a fleet-wide command applies to, without letting an
   *  unreadable Grail tree throw out of the command. */
  _commandTargets(ancestorRappid) {
    if (ancestorRappid) return [ancestorRappid];
    try {
      return this.baselineAncestors().map((baseline) => baseline.ancestorRappid);
    } catch {
      return [];
    }
  }

  /** Move HEAD across loci, isolating each one. A single failing locus must never
   *  abort the fleet and leave the rest molted — the whole point of the control word
   *  is that it always lands somewhere safe. Returns a report, never throws. */
  _moveHeads(targets, pick, env = DEFAULT_ENV) {
    const environment = normalizeEnvironment(env);
    const changed = [];
    const unchanged = [];
    const failed = [];
    for (const target of targets) {
      let before = null;
      try { before = this.resolveLive(target, { env: environment }); } catch {}
      try {
        const next = pick(target);
        const moved = this.setHead(target, next, { env: environment });
        if (moved !== true) {
          throw new Error(
            moved?.reason || `HEAD.${environment} write was refused.`,
          );
        }
        const after = this.resolveLive(target, { env: environment });
        // A pointer rewrite is not a user-visible change when both HEADs resolve
        // to the same served artifact (for example, a missing ring and baseline).
        if (sameResolution(before, after)) unchanged.push(target);
        else changed.push(target);
      } catch (error) {
        failed.push({ ancestorRappid: target, error: String(error?.message || error) });
      }
    }
    return { disabled: false, changed, unchanged, failed };
  }

  rollbackToBaseline(ancestorRappid = null, env = DEFAULT_ENV) {
    if (
      ancestorRappid
      && typeof ancestorRappid === "object"
      && !Array.isArray(ancestorRappid)
    ) {
      env = ancestorRappid;
      ancestorRappid = null;
    }
    const environment = normalizeEnvironment(env);
    if (!this.isEnabled()) return { disabled: true, changed: [], unchanged: [], failed: [] };
    return this._moveHeads(this._commandTargets(ancestorRappid), (target) => {
      // Remember where we were, so restore returns here instead of fast-
      // forwarding to whatever ring happens to be newest.
      try {
        const current = this.getHead(target, { env: environment });
        if (
          current
          && current !== target
          && this._pathIsValid(target, current, { requireVerified: true })
        ) {
          atomicWrite(
            this._priorHeadPath(target, environment),
            `${current}\n`,
          );
        }
      } catch {}
      return target;
    }, environment);
  }

  restore(ancestorRappid = null, env = DEFAULT_ENV) {
    if (
      ancestorRappid
      && typeof ancestorRappid === "object"
      && !Array.isArray(ancestorRappid)
    ) {
      env = ancestorRappid;
      ancestorRappid = null;
    }
    const environment = normalizeEnvironment(env);
    if (!this.isEnabled()) return { disabled: true, changed: [], unchanged: [], failed: [] };
    return this._moveHeads(this._commandTargets(ancestorRappid), (target) => {
      // Pinned loci stay at baseline: restore must not fight the pin.
      if (this.locusPolicy(target) === "pinned") return target;
      // Prefer the generation the last rollback displaced — restore is the
      // inverse of baseline, not a fast-forward.
      const current = this.getHead(target, { env: environment });
      const prior = current === target
        ? this._readPriorHead(target, environment)
        : null;
      if (
        prior
        && prior !== target
        && this._pathIsValid(target, prior, { requireVerified: true })
      ) {
        return prior;
      }
      const latest = this.listRings(target)
        .filter((ring) => (
          ring.ringRappid !== target
          && ring.verified === true
          && this._pathIsValid(
            target,
            ring.ringRappid,
            { requireVerified: true },
          )
        ))
        .sort(newestFirst)[0];
      return latest?.ringRappid || target;
    }, environment);
  }

  _promotionsFile(ancestorRappid) {
    return path.join(this._locusDirectory(ancestorRappid), "promotions.json");
  }

  _promotionJournal(ancestorRappid) {
    const file = this._promotionsFile(ancestorRappid);
    if (!existsSync(file)) return { file, log: [], corrupt: false };
    const log = readJsonSafe(file);
    if (!Array.isArray(log)) return { file, log: null, corrupt: true };
    return { file, log, corrupt: false };
  }

  _recordPromotion(ancestorRappid, entry) {
    try {
      const verification = this.verifyPromotions(ancestorRappid);
      if (!verification.ok) return null;
      const { file, log, corrupt } = this._promotionJournal(ancestorRappid);
      if (corrupt) return null;
      const previous = log.length
        ? log[log.length - 1].entry_sha256
        : null;
      const record = {
        schema: LINEAGE_SCHEMA,
        ...entry,
        prev_entry_sha256: previous,
      };
      record.entry_sha256 = sha256Hex(JSON.stringify(record));
      const serialized = `${JSON.stringify([...log, record], null, 2)}\n`;
      if (
        Buffer.byteLength(serialized, "utf8")
        > MAX_PROMOTION_JOURNAL_BYTES
      ) return null;
      atomicWrite(file, serialized);
      return record;
    } catch {
      return null;
    }
  }

  listPromotions(ancestorRappid) {
    try {
      return this._promotionJournal(ancestorRappid).log || [];
    } catch {
      return [];
    }
  }

  verifyPromotions(ancestorRappid) {
    let journal;
    try {
      journal = this._promotionJournal(ancestorRappid);
    } catch {
      return {
        ok: false,
        corrupt: true,
        reason: JOURNAL_CORRUPT_REASON,
      };
    }
    if (journal.corrupt) {
      return {
        ok: false,
        corrupt: true,
        reason: JOURNAL_CORRUPT_REASON,
      };
    }
    let previous = null;
    for (let index = 0; index < journal.log.length; index += 1) {
      const { entry_sha256: digest, ...entry } = journal.log[index] || {};
      if (
        entry.prev_entry_sha256 !== previous
        || sha256Hex(JSON.stringify(entry)) !== digest
      ) {
        return { ok: false, broken_at: index };
      }
      previous = digest;
    }
    return { ok: true, entries: journal.log.length };
  }

  promote(
    ancestorRappid,
    {
      fromEnv = DEFAULT_ENV,
      toEnv = DEFAULT_ENV,
      actor = null,
      utc = null,
    } = {},
  ) {
    const sourceEnvironment = normalizeEnvironment(fromEnv);
    const targetEnvironment = normalizeEnvironment(toEnv);
    if (!this.isEnabled()) {
      return disabledMutation("promote", targetEnvironment);
    }
    if (!this._baseline(ancestorRappid)) {
      return {
        ok: false,
        refused: true,
        reason: `Unknown Grail ancestor: ${ancestorRappid}`,
      };
    }
    const journal = this.verifyPromotions(ancestorRappid);
    if (!journal.ok) {
      return {
        ok: false,
        journal_corrupt: true,
        refused: true,
        reason: JOURNAL_CORRUPT_REASON,
      };
    }
    const record = (outcome) => {
      const written = this._recordPromotion(ancestorRappid, {
        from_env: sourceEnvironment,
        to_env: targetEnvironment,
        actor,
        utc: utc || this.now(),
        ...outcome,
      });
      if (!written) {
        return {
          ok: false,
          journal_refused: true,
          refused: true,
          reason: JOURNAL_WRITE_REASON,
        };
      }
      return outcome;
    };

    try {
      const sourceHead = this.getHead(
        ancestorRappid,
        { env: sourceEnvironment },
      );
      const targetHead = this.getHead(
        ancestorRappid,
        { env: targetEnvironment },
      );
      const sourceChain = this.walk(ancestorRappid, sourceHead);
      const targetChain = this.walk(ancestorRappid, targetHead);
      if (!sourceChain.length) {
        return record({
          ok: false,
          refused: true,
          reason: "source environment HEAD is not a verified lineage",
          source_head: sourceHead,
        });
      }
      if (!targetChain.length) {
        return record({
          ok: false,
          refused: true,
          reason: "target environment HEAD is not a verified lineage",
          target_head: targetHead,
          source_head: sourceHead,
        });
      }
      if (sourceHead === targetHead) {
        return record({
          ok: true,
          reason: "already in sync",
          noop: true,
          target_head: targetHead,
          source_head: sourceHead,
        });
      }
      if (!sourceChain.includes(targetHead)) {
        const commonAncestor = [...sourceChain]
          .reverse()
          .find((ringRappid) => targetChain.includes(ringRappid))
          || null;
        return record({
          ok: false,
          conflict: true,
          reason: "target environment has diverged (a conflicting molt the promotion did not build on)",
          target_head: targetHead,
          source_head: sourceHead,
          common_ancestor: commonAncestor,
        });
      }

      // Journal the successful fast-forward before moving the pointer: a HEAD
      // must never advance if its audit record cannot be durably written.
      const outcome = {
        ok: true,
        reason: "fast-forward",
        target_head: sourceHead,
        source_head: sourceHead,
      };
      const recorded = record(outcome);
      if (!recorded.ok) return recorded;
      const moved = this.setHead(
        ancestorRappid,
        sourceHead,
        { env: targetEnvironment },
      );
      if (moved !== true) {
        return {
          ok: false,
          disabled: Boolean(moved?.disabled),
          refused: true,
          reason: moved?.reason || "target HEAD write was refused",
          source_head: sourceHead,
          target_head: targetHead,
        };
      }
      return outcome;
    } catch (error) {
      return record({
        ok: false,
        refused: true,
        reason: `promotion failed: ${String(error?.message || error)}`,
      });
    }
  }

  promoteAll({
    fromEnv = DEFAULT_ENV,
    toEnv = DEFAULT_ENV,
    actor = null,
    utc = null,
  } = {}) {
    if (!this.isEnabled()) {
      return {
        disabled: true,
        changed: [],
        unchanged: [],
        conflicts: [],
        failed: [],
      };
    }
    const changed = [];
    const unchanged = [];
    const conflicts = [];
    const failed = [];
    for (const baseline of this.baselineAncestors()) {
      try {
        const outcome = this.promote(baseline.ancestorRappid, {
          fromEnv,
          toEnv,
          actor,
          utc,
        });
        if (outcome.ok && outcome.noop) {
          unchanged.push(baseline.ancestorRappid);
        } else if (outcome.ok) {
          changed.push(baseline.ancestorRappid);
        } else if (outcome.conflict) {
          conflicts.push({
            ancestorRappid: baseline.ancestorRappid,
            filename: baseline.filename,
            ...outcome,
          });
        } else {
          failed.push({
            ancestorRappid: baseline.ancestorRappid,
            filename: baseline.filename,
            error: outcome.reason || "promotion was refused",
            ...outcome,
          });
        }
      } catch (error) {
        failed.push({
          ancestorRappid: baseline.ancestorRappid,
          filename: baseline.filename,
          error: String(error?.message || error),
        });
      }
    }
    return {
      disabled: false,
      changed,
      unchanged,
      conflicts,
      failed,
    };
  }

  detectDrift(ancestorRappid, env, expectedBaseRing) {
    const environment = normalizeEnvironment(env);
    const actual = this.getHead(ancestorRappid, { env: environment });
    const expected = expectedBaseRing || null;
    return {
      drifted: (actual || null) !== expected,
      actual: actual || null,
      expected,
      env: environment,
    };
  }

  /** Count ring directories on disk whose metadata will not parse. listRings
   *  deliberately drops these so composition stays fail-safe, but an integrity
   *  check must not inherit that blindness — otherwise the audit surface hides
   *  exactly the corruption it exists to find. */
  _corruptRingCount(ancestorRappid) {
    const ringsDirectory = this._ringsDirectory(ancestorRappid);
    if (!existsSync(ringsDirectory)) return 0;
    return readdirSync(ringsDirectory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .filter((entry) => {
        const meta = readJsonSafe(
          path.join(ringsDirectory, entry.name, RING_META_FILE),
        );
        return !meta || typeof meta.ringRappid !== "string";
      })
      .length;
  }

  /** Health report for a locus. verifyChain() answers only "does the reachable
   *  chain verify" — deliberately, so unreachable corruption never breaks
   *  composition. This surfaces the corruption that answer omits, so operators
   *  (and the runtime diagnostics layer) can see corruption on disk instead of inferring
   *  health from a boolean that was never asked the question. */
  inspectLineage(ancestorRappid) {
    let corruptRings = 0;
    try {
      corruptRings = this._corruptRingCount(ancestorRappid);
    } catch {
      corruptRings = 0;
    }
    let chainOk = false;
    try {
      chainOk = this.verifyChain(ancestorRappid);
    } catch {
      chainOk = false;
    }
    let head = null;
    try {
      head = this.getHead(ancestorRappid);
    } catch {
      head = null;
    }
    return {
      ancestorRappid,
      chainOk,
      corruptRings,
      healthy: chainOk && corruptRings === 0,
      head,
    };
  }

  verifyChain(ancestorRappid) {
    const baseline = this._baseline(ancestorRappid);
    if (!baseline) return false;
    try {
      return this.listRings(ancestorRappid)
        .filter((ring) => ring.ringRappid !== ancestorRappid)
        .every((ring) => (
          this._ringIsValid(ancestorRappid, ring.ringRappid)
          && this._pathIsValid(ancestorRappid, ring.ringRappid)
        ));
    } catch {
      return false;
    }
  }
}

export const lineageStoreInternals = {
  ancestorRappidFor,
  filesystemSegment,
  normalizeEnvironment,
  ringRappidFor,
  sourceSha256,
};

let defaultStore = null;

export function configureLineageStore(options = {}) {
  defaultStore = options instanceof LineageStore
    ? options
    : new LineageStore({
        brainstemDir: process.env.BRAINSTEM_BETA_SOURCE_DIR
          || path.join(os.homedir(), ".brainstem", "src", "rapp_brainstem"),
        ...options,
      });
  return defaultStore;
}

function configuredStore() {
  return defaultStore || configureLineageStore();
}

export function baselineAncestors() {
  return configuredStore().baselineAncestors();
}

export function listRings(ancestorRappid) {
  return configuredStore().listRings(ancestorRappid);
}

export function appendRing(ancestorRappid, frame) {
  return configuredStore().appendRing(ancestorRappid, frame);
}

export function getHead(ancestorRappid, env = DEFAULT_ENV) {
  return configuredStore().getHead(ancestorRappid, env);
}

export function setHead(ancestorRappid, ringRappid, env = DEFAULT_ENV) {
  return configuredStore().setHead(ancestorRappid, ringRappid, env);
}

export function resolveLive(ancestorRappid, env = DEFAULT_ENV) {
  return configuredStore().resolveLive(ancestorRappid, env);
}

export function rollbackToBaseline(
  ancestorRappid = null,
  env = DEFAULT_ENV,
) {
  return configuredStore().rollbackToBaseline(ancestorRappid, env);
}

export function restore(ancestorRappid = null, env = DEFAULT_ENV) {
  return configuredStore().restore(ancestorRappid, env);
}

export function verifyChain(ancestorRappid) {
  return configuredStore().verifyChain(ancestorRappid);
}

export function inspectLineage(ancestorRappid) {
  return configuredStore().inspectLineage(ancestorRappid);
}

export function locusPolicy(ancestorRappid) {
  return configuredStore().locusPolicy(ancestorRappid);
}

export function setLocusPolicy(ancestorRappid, policy) {
  return configuredStore().setLocusPolicy(ancestorRappid, policy);
}

export function environments(ancestorRappid) {
  return configuredStore().environments(ancestorRappid);
}

export function walk(ancestorRappid, ringRappid) {
  return configuredStore().walk(ancestorRappid, ringRappid);
}

export function promote(ancestorRappid, options = {}) {
  return configuredStore().promote(ancestorRappid, options);
}

export function promoteAll(options = {}) {
  return configuredStore().promoteAll(options);
}

export function detectDrift(ancestorRappid, env, expectedBaseRing) {
  return configuredStore().detectDrift(
    ancestorRappid,
    env,
    expectedBaseRing,
  );
}

export function listPromotions(ancestorRappid) {
  return configuredStore().listPromotions(ancestorRappid);
}

export function verifyPromotions(ancestorRappid) {
  return configuredStore().verifyPromotions(ancestorRappid);
}
