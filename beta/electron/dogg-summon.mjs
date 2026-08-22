import { RappStoreClient } from "./rapp-store.mjs";

export const DOGG_SUMMON_SCHEMA = "openrappter-dogg-summon/1.0";
const RAW_PINNED = /^https:\/\/raw\.githubusercontent\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/[0-9a-f]{40}\/[^?#\s]+$/;

export function validateDoggRawUrl(value) {
  const source = String(value || "");
  if (!RAW_PINNED.test(source)) {
    throw new Error(
      "DOGG summons_full must be an immutable GitHub raw URL pinned to a 40-character commit.",
    );
  }
  return source;
}

export async function summonDoggNeighborhood({
  fetchImpl = fetch,
  instruction = null,
  storeId,
  summonsFull,
  twinManager,
} = {}) {
  if (!twinManager?.hatchFromStore) {
    throw new Error("DOGG summon requires the local estate TwinManager.");
  }
  const catalogUrl = validateDoggRawUrl(summonsFull);
  const id = String(storeId || "").trim();
  if (!/^[a-z0-9][a-z0-9._-]{1,127}$/i.test(id)) {
    throw new Error("DOGG summon requires a safe public catalog entry id.");
  }
  const store = new RappStoreClient({
    fetchImpl,
    recallMaxAgeMs: 0,
    url: catalogUrl,
  });
  const entry = (await store.list()).find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`DOGG catalog has no entry ${id}.`);
  for (const [label, url] of [
    ["singleton", entry.singletonUrl],
    ["egg", entry.eggUrl],
    ["UI", entry.uiUrl],
  ]) {
    if (url) {
      try {
        validateDoggRawUrl(url);
      } catch {
        throw new Error(`DOGG ${label} payload is not immutable GitHub raw user data.`);
      }
    }
  }
  const neighborhood = await twinManager.hatchFromStore(store, id, {
    instruction,
  });
  return {
    ...neighborhood,
    dogg: {
      schema: DOGG_SUMMON_SCHEMA,
      summons_full: catalogUrl,
      store_id: id,
      source: "github-raw-user-data",
      authority: "local-estate-decides",
    },
  };
}
