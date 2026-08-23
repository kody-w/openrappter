export const GOOD_AI_NEIGHBOR_SCHEMA = "openrappter-good-ai-neighbor/1.0";

const INSTANCE = /^[a-z][a-z0-9-]{2,63}$/;

export function normalizeNeighborhoodInstance(value) {
  const requested = String(value || "alpha");
  return INSTANCE.test(requested) ? requested : "alpha";
}

function titleCase(slug) {
  return slug.split("-")
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}

function badge(slug) {
  if (slug === "alpha") return "";
  const words = slug.split("-").filter(Boolean);
  return words.slice(0, 3).map((word) => word[0]).join("").toUpperCase()
    || slug.slice(0, 2).toUpperCase();
}

export function createNeighborhoodIdentity(value, {
  generation = 0,
  neighborhoodId = null,
  parentNeighborhoodId = null,
} = {}) {
  const instance = normalizeNeighborhoodInstance(value);
  const instanceName = titleCase(instance);
  const requestedId = String(neighborhoodId || "");
  const validId = new RegExp(
    `^openrappter:${instance}(?::[0-9a-f]{64})?$`,
  ).test(requestedId)
    ? requestedId
    : `openrappter:${instance}`;
  const uniqueTail = validId.split(":").at(-1);
  const shortIdentity = /^[0-9a-f]{64}$/.test(uniqueTail)
    ? uniqueTail.slice(0, 4)
    : "";
  const instanceBadge = badge(instance);
  return Object.freeze({
    schema: GOOD_AI_NEIGHBOR_SCHEMA,
    estate_id: `estate:${validId}`,
    neighborhood_id: validId,
    root_neighborhood_id: validId,
    parent_neighborhood_id: parentNeighborhoodId || null,
    generation: Number.isSafeInteger(generation) && generation >= 0
      ? generation
      : 0,
    instance,
    instance_name: instanceName,
    app_name: instance === "alpha"
      ? "OpenRappter"
      : `OpenRappter · ${instanceName}${
          shortIdentity ? ` · ${shortIdentity}` : ""
        }`,
    dock_badge: `${instanceBadge}${shortIdentity.slice(0, 2).toUpperCase()}`,
    app_user_model_id: `io.github.kody-w.openrappter.neighborhood.${instance}${
      shortIdentity ? `.${shortIdentity}` : ""
    }`,
    container: "electron-app",
    durability: "data-defined",
    ownership: "one-app-one-estate",
    neighborhood_model: "one-estate-many-neighborhoods",
    collaboration: "attributed-post-chat-only",
  });
}

function estateNeighborhoods(identity, neighborhoods) {
  const entries = neighborhoods || [{
    kind: "root",
    neighborhood_id: identity.root_neighborhood_id,
    name: identity.instance_name,
    rappid: null,
  }];
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("An AI estate must contain its root neighborhood.");
  }
  const seen = new Set();
  let roots = 0;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("Estate neighborhoods must be objects.");
    }
    const neighborhoodId = String(entry.neighborhood_id || "");
    if (!neighborhoodId || seen.has(neighborhoodId)) {
      throw new Error("Estate neighborhood IDs must be present and unique.");
    }
    seen.add(neighborhoodId);
    if (entry.kind === "root") {
      roots += 1;
      if (
        neighborhoodId !== identity.root_neighborhood_id
        || entry.rappid !== null
      ) {
        throw new Error("The estate root neighborhood conflicts with its identity.");
      }
      continue;
    }
    const rappid = String(entry.rappid || "");
    if (
      entry.kind !== "resident"
      || !rappid
      || neighborhoodId !== `${identity.estate_id}:resident:${rappid}`
    ) {
      throw new Error("A foreign neighborhood cannot enter this AI estate.");
    }
  }
  if (roots !== 1) {
    throw new Error("An AI estate must contain exactly one root neighborhood.");
  }
  return entries;
}

export function ensureNeighborhoodManifest(betaHome, identity, {
  neighborhoods = null,
  now = () => new Date(),
} = {}) {
  const file = path.join(path.resolve(betaHome), "neighborhood.json");
  let createdAt = now().toISOString();
  if (existsSync(file)) {
    const existing = JSON.parse(readFileSync(file, "utf8"));
    if (
      existing?.schema !== GOOD_AI_NEIGHBOR_SCHEMA
      || existing.neighborhood_id !== identity.neighborhood_id
    ) {
      throw new Error("Persisted neighborhood manifest conflicts with this Electron container.");
    }
    createdAt = existing.created_at;
  }
  const manifest = {
    ...identity,
    neighborhoods: estateNeighborhoods(identity, neighborhoods),
    created_at: createdAt,
  };
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(temporary, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    // Windows does not expose POSIX modes.
  }
  return { file, manifest };
}
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
