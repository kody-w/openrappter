import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  DEFAULT_STORE_URL,
  isAllowedStoreSourceUrl,
  RappStoreClient,
  rappStoreInternals,
  STORE_SCHEMA,
} from "../electron/rapp-store.mjs";

const AGENT = "from agents.basic_agent import BasicAgent\n# demo singleton\n";
const AGENT_SHA = createHash("sha256").update(Buffer.from(AGENT)).digest("hex");

function fakeStore({ agentBytes = AGENT, sha = AGENT_SHA, gated404 = false } = {}) {
  const catalog = {
    schema: STORE_SCHEMA,
    generated_at: "2026-08-18",
    gated_rapplications_note: "gated entries are private",
    rapplications: [
      {
        id: "demo", name: "Demo", version: "1.0.0", summary: "s", category: "c", tags: [],
        singleton_filename: "demo_agent.py",
        singleton_url: "https://example/demo_agent.py",
        singleton_sha256: sha, singleton_bytes: agentBytes.length, quality_tier: "community",
        ui_url: "https://example/demo/index.html", ui_filename: "index.html", license: "MIT",
      },
      {
        id: "locked", name: "Locked", singleton_filename: "locked_agent.py",
        singleton_url: "https://example/private/locked_agent.py",
        singleton_sha256: "deadbeef", access: "private", quality_tier: "private",
      },
    ],
  };
  const fetchImpl = async (url) => {
    if (url.endsWith("index.json") || url === "store") {
      return { ok: true, status: 200, json: async () => catalog };
    }
    if (url.includes("/private/")) {
      return gated404
        ? { ok: false, status: 404 }
        : { ok: true, status: 200, arrayBuffer: async () => Buffer.from(AGENT) };
    }
    return { ok: true, status: 200, arrayBuffer: async () => Buffer.from(agentBytes) };
  };
  return new RappStoreClient({ url: "store", fetchImpl });
}

test("loads the catalog and flags gated entries", async () => {
  const client = fakeStore();
  const list = await client.list();
  assert.equal(list.length, 2);
  assert.equal(list.find((e) => e.id === "demo").gated, false);
  assert.equal(list.find((e) => e.id === "locked").gated, true);
  // a rapplication carries its own UI (agents + specialized UI)
  assert.equal(list.find((e) => e.id === "demo").uiUrl, "https://example/demo/index.html");
  assert.equal(list.find((e) => e.id === "demo").license, "MIT");
});

test("download verifies the pinned sha256 before returning source", async () => {
  const ok = await fakeStore().download("demo");
  assert.equal(ok.filename, "demo_agent.py");
  assert.match(ok.source, /BasicAgent/);
  assert.equal(ok.verified, true);
  assert.equal(ok.sha256, AGENT_SHA);
});

test("a sha256 mismatch refuses to hatch", async () => {
  const client = fakeStore({ sha: "0".repeat(64) });
  await assert.rejects(() => client.download("demo"), /sha256 mismatch/);
});

test("a gated 404 surfaces an auth-needed error, not a silent miss", async () => {
  const client = fakeStore({ gated404: true });
  await assert.rejects(
    () => client.download("locked"),
    (error) => error.code === "gated" && /gated/.test(error.message),
  );
});

test("a yanked rapplication cannot resolve or download even when addressed directly", async () => {
  const catalog = {
    schema: STORE_SCHEMA,
    rapplications: [{
      id: "recalled",
      name: "Recalled",
      yanked: true,
      singleton_filename: "recalled_agent.py",
      singleton_url: "https://example/recalled_agent.py",
      singleton_sha256: AGENT_SHA,
    }],
  };
  let singletonFetches = 0;
  const client = new RappStoreClient({
    url: "store",
    fetchImpl: async (url) => {
      if (url === "store") {
        return { ok: true, status: 200, json: async () => catalog };
      }
      singletonFetches += 1;
      return { ok: true, status: 200, arrayBuffer: async () => Buffer.from(AGENT) };
    },
  });
  const recalled = (error) => error.code === "yanked" && /yanked \(recalled\)/.test(error.message);
  await assert.rejects(() => client.resolve("recalled"), recalled);
  await assert.rejects(() => client.download("recalled"), recalled);
  assert.equal(singletonFetches, 0);
});

test("a deprecated rapplication refuses install/hatch with its own named reason, distinct from yanked", async () => {
  const catalog = {
    schema: STORE_SCHEMA,
    rapplications: [{
      id: "sunset",
      name: "Sunset",
      deprecated: true,
      singleton_filename: "sunset_agent.py",
      singleton_url: "https://example/sunset_agent.py",
      singleton_sha256: AGENT_SHA,
    }],
  };
  let singletonFetches = 0;
  const client = new RappStoreClient({
    url: "store",
    fetchImpl: async (url) => {
      if (url === "store") {
        return { ok: true, status: 200, json: async () => catalog };
      }
      singletonFetches += 1;
      return { ok: true, status: 200, arrayBuffer: async () => Buffer.from(AGENT) };
    },
  });
  const deprecated = (error) => (
    error.code === "deprecated"
    && /deprecated by its publisher/.test(error.message)
    && !/yanked/.test(error.message)
  );
  await assert.rejects(() => client.resolve("sunset"), deprecated);
  await assert.rejects(() => client.download("sunset"), deprecated);
  assert.equal(singletonFetches, 0);
  // Still visible to list() so the shelf can explain the deprecation.
  assert.equal((await client.list())[0].deprecated, true);
});

test("min_app_version newer than the running launcher refuses to hatch; same-or-newer launcher hatches", async () => {
  const catalog = {
    schema: STORE_SCHEMA,
    rapplications: [{
      id: "needs-newer",
      name: "Needs Newer",
      min_app_version: "0.1.0-beta.9",
      singleton_filename: "needs_newer_agent.py",
      singleton_url: "https://example/needs_newer_agent.py",
      singleton_sha256: AGENT_SHA,
    }],
  };
  const fetchImpl = async (url) => {
    if (url === "store") {
      return { ok: true, status: 200, json: async () => catalog };
    }
    return { ok: true, status: 200, arrayBuffer: async () => Buffer.from(AGENT) };
  };
  const tooOld = new RappStoreClient({ url: "store", fetchImpl, appVersion: "0.1.0-beta.7" });
  const needsUpdate = (error) => (
    error.code === "min_app_version"
    && /needs app version 0\.1\.0-beta\.9 or newer/.test(error.message)
    && /this launcher is 0\.1\.0-beta\.7/.test(error.message)
  );
  await assert.rejects(() => tooOld.resolve("needs-newer"), needsUpdate);
  await assert.rejects(() => tooOld.download("needs-newer"), needsUpdate);

  const exact = new RappStoreClient({ url: "store", fetchImpl, appVersion: "0.1.0-beta.9" });
  assert.equal((await exact.resolve("needs-newer")).id, "needs-newer");
  const newer = new RappStoreClient({ url: "store", fetchImpl, appVersion: "0.1.0" });
  assert.equal((await newer.download("needs-newer")).sha256, AGENT_SHA);
});

test("the enforced app version defaults to the launcher's own package.json", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const client = new RappStoreClient({ url: "store", fetchImpl: async () => ({}) });
  assert.equal(client.appVersion, pkg.version);
});

test("store installs validate and persist before an atomic routed-worker swap", () => {
  const main = readFileSync(
    new URL("../electron/main.mjs", import.meta.url),
    "utf8",
  ).replaceAll("\r\n", "\n");
  const start = main.indexOf("async function installAgentToBrainstem");
  const end = main.indexOf("\nconst twinManager", start);
  const install = main.slice(start, end);
  assert.match(install, /routeManager\.installScopedAgent/);
  assert.match(install, /routeManager\.startDefault/);
  assert.doesNotMatch(install, /agents\/import|FormData|hot-loaded only/);
});

test("a yanked registry agent is also refused by the normalized client", async () => {
  const registry = {
    schema: "rapp-agent/1.0",
    agents: [{
      name: "@test/recalled",
      display_name: "Recalled",
      _file: "agents/recalled_agent.py",
      _sha256: AGENT_SHA,
      yanked: true,
    }],
  };
  const client = new RappStoreClient({
    url: "https://example.test/registry.json",
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => registry }),
  });
  await assert.rejects(
    () => client.resolve("recalled"),
    (error) => error.code === "yanked",
  );
});

test("rejects an unexpected catalog schema", async () => {
  const client = new RappStoreClient({
    url: "store",
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ schema: "wrong", rapplications: [] }) }),
  });
  await assert.rejects(() => client.list(), /Unexpected RAR catalog schema/);
});

test("a pinned UI downloads verified; an unpinned ui_url is never fetched; a mismatch refuses", async () => {
  const ui = Buffer.from("<html>studio</html>");
  const { createHash } = await import("node:crypto");
  const uiSha = createHash("sha256").update(ui).digest("hex");
  const agent = Buffer.from("print('hi')\n");
  const agentSha = createHash("sha256").update(agent).digest("hex");
  const mkCatalog = (uiPin) => ({
    schema: "rapp-store/1.0",
    rapplications: [{
      id: "studio", name: "Studio", singleton_url: "https://x/agent.py", singleton_filename: "s_agent.py",
      singleton_sha256: agentSha, ui_url: "https://x/ui.html",
      ...(uiPin ? { ui_sha256: uiPin } : {}),
    }],
  });
  const fetchedUrls = [];
  const mkFetch = (catalog) => async (url) => {
    fetchedUrls.push(url);
    if (url === "store") return { ok: true, status: 200, json: async () => catalog };
    if (url.endsWith("ui.html")) return { ok: true, status: 200, arrayBuffer: async () => ui };
    return { ok: true, status: 200, arrayBuffer: async () => agent };
  };
  // pinned + matching → uiHtml delivered
  let c = new RappStoreClient({ url: "store", fetchImpl: mkFetch(mkCatalog(uiSha)) });
  let d = await c.download("studio");
  assert.equal(d.uiHtml, "<html>studio</html>");
  assert.equal(d.uiNote, null);
  // unpinned → never fetched, note explains the Grail fallback
  fetchedUrls.length = 0;
  c = new RappStoreClient({ url: "store", fetchImpl: mkFetch(mkCatalog(null)) });
  d = await c.download("studio");
  assert.equal(d.uiHtml, null);
  assert.match(d.uiNote, /no sha256 pin/);
  assert.ok(!fetchedUrls.some((u) => u.endsWith("ui.html")), "unpinned ui_url must not be fetched");
  // pinned + mismatch → refused
  c = new RappStoreClient({ url: "store", fetchImpl: mkFetch(mkCatalog("f".repeat(64))) });
  await assert.rejects(() => c.download("studio"), /UI: sha256 mismatch/);
});

test("a pinned egg downloads verified; an unpinned egg_url is never fetched; a mismatch refuses", async () => {
  const egg = Buffer.from("verified egg bytes");
  const eggSha = createHash("sha256").update(egg).digest("hex");
  const agent = Buffer.from("print('hi')\n");
  const agentSha = createHash("sha256").update(agent).digest("hex");
  const mkCatalog = (eggPin) => ({
    schema: STORE_SCHEMA,
    rapplications: [{
      id: "studio", name: "Studio", singleton_url: "https://x/agent.py", singleton_filename: "s_agent.py",
      singleton_sha256: agentSha, egg_url: "https://x/state.egg",
      ...(eggPin ? { egg_sha256: eggPin } : {}),
    }],
  });
  const fetchedUrls = [];
  const mkFetch = (catalog) => async (url) => {
    fetchedUrls.push(url);
    if (url === "store") return { ok: true, status: 200, json: async () => catalog };
    if (url.endsWith(".egg")) return { ok: true, status: 200, arrayBuffer: async () => egg };
    return { ok: true, status: 200, arrayBuffer: async () => agent };
  };

  let client = new RappStoreClient({ url: "store", fetchImpl: mkFetch(mkCatalog(eggSha)) });
  let downloaded = await client.download("studio");
  assert.deepEqual(downloaded.egg, egg);
  assert.equal(downloaded.eggNote, null);

  fetchedUrls.length = 0;
  client = new RappStoreClient({ url: "store", fetchImpl: mkFetch(mkCatalog(null)) });
  downloaded = await client.download("studio");
  assert.equal(downloaded.egg, null);
  assert.match(downloaded.eggNote, /no sha256 pin/);
  assert.ok(!fetchedUrls.some((url) => url.endsWith(".egg")), "unpinned egg_url must not be fetched");

  client = new RappStoreClient({ url: "store", fetchImpl: mkFetch(mkCatalog("f".repeat(64))) });
  await assert.rejects(() => client.download("studio"), /egg: sha256 mismatch/);
});

test("store source URLs accept only https or an exact loopback HTTP host", () => {
  assert.equal(isAllowedStoreSourceUrl("http://localhost.evil.com/x"), false);
  assert.equal(isAllowedStoreSourceUrl("http://127.0.0.1.evil.com/x"), false);
  assert.equal(isAllowedStoreSourceUrl("http://127.0.0.1:8125/index.json"), true);
  assert.equal(isAllowedStoreSourceUrl("http://localhost:8080/x"), true);
  assert.equal(isAllowedStoreSourceUrl("https://example.com/index.json"), true);
});

test("registry adapter resolves raw URLs relative to a custom catalog base", async () => {
  const registry = {
    schema: "rapp-agent/1.0",
    agents: [{
      name: "@me/thing", display_name: "Thing", _file: "agents/thing_agent.py",
      _sha256: "b".repeat(64), _install_filename: "thing_agent.py",
    }],
  };
  const c = new RappStoreClient({
    url: "https://me.github.io/my-rar/registry.json",
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => registry }),
  });
  const [e] = await c.list();
  assert.equal(e.singletonUrl, "https://me.github.io/my-rar/agents/thing_agent.py");
});

test("adapts an AIBAST-style registry into pinned store entries", async () => {
  const registry = {
    schema: "rapp-agent/1.0",
    agents: [{
      name: "@aibast-agents-library/account-intelligence",
      display_name: "Account Intelligence Agent",
      description: "Automate account research.",
      category: "b2b_sales",
      quality_tier: "verified",
      _file: "agents/@aibast-agents-library/b2b_sales_stacks/account_intelligence_stack/account_intelligence_agent.py",
      _sha256: "a".repeat(64),
      _install_filename: "account_intelligence__aaaaaaaaaaaa_agent.py",
      _size_kb: 26.3,
    }, {
      name: "@aibast-agents-library/no-pin",
      _file: "agents/x_agent.py",
      // no _sha256 — must be dropped, never listed unpinned
    }],
  };
  const client = new RappStoreClient({
    url: "https://microsoft.github.io/aibast-agents-library/registry.json",
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => registry }),
  });
  const list = await client.list();
  assert.equal(list.length, 1);
  const e = list[0];
  assert.equal(e.id, "account-intelligence");
  assert.equal(e.singletonSha256, "a".repeat(64));
  assert.match(e.singletonUrl, /^https:\/\/raw\.githubusercontent\.com\/microsoft\/aibast-agents-library\/main\/agents\//);
  assert.equal(e.singletonFilename, "account_intelligence__aaaaaaaaaaaa_agent.py");
  assert.equal(e.gated, false);
});

test("a download carries which catalog vouched for it", async () => {
  // A catalog supplies BOTH the bytes and the sha256 that "verifies" them, so a
  // pin proves internal consistency, never origin. The only real trust signal is
  // which catalog it was — so that must travel with the download.
  const source = "AGENT = 'from the default catalog'\n";
  const digest = createHash("sha256").update(Buffer.from(source)).digest("hex");
  const index = {
    schema: "rapp-store/1.0",
    rapplications: [{
      id: "demo",
      singleton_filename: "demo_agent.py",
      singleton_url: "https://example.invalid/demo_agent.py",
      singleton_sha256: digest,
    }],
  };
  const fetchImpl = async (url) => (
    String(url).endsWith("demo_agent.py")
      ? { ok: true, status: 200, arrayBuffer: async () => Buffer.from(source) }
      : { ok: true, status: 200, json: async () => index }
  );

  const trusted = new RappStoreClient({ url: DEFAULT_STORE_URL, fetchImpl });
  const fromDefault = await trusted.download("demo");
  assert.equal(fromDefault.storeUrl, DEFAULT_STORE_URL);
  assert.equal(fromDefault.trustedSource, true);

  const custom = new RappStoreClient({
    url: "https://someone-elses-catalog.invalid/index.json",
    fetchImpl,
  });
  const fromCustom = await custom.download("demo");
  assert.equal(fromCustom.storeUrl, "https://someone-elses-catalog.invalid/index.json");
  assert.equal(
    fromCustom.trustedSource,
    false,
    "a catalog the user pointed at must not be indistinguishable from a default",
  );
  // Both verified against their own catalog's pin — which is exactly the point:
  // the pin cannot tell these two apart, only the provenance can.
  assert.equal(fromDefault.sha256, fromCustom.sha256);
  assert.equal(fromDefault.verified, fromCustom.verified);
});

// A launcher that loaded its catalog long ago must still honor a publisher's
// recall before it RUNS anything — not only after a restart or a source switch.
function recallStore({ recallMaxAgeMs = 60_000 } = {}) {
  let clock = 1_000_000;
  let yanked = false;
  let catalogFetches = 0;
  let failCatalog = false;
  const entry = () => ({
    id: "demo",
    name: "Demo",
    version: "1.0.0",
    singleton_filename: "demo_agent.py",
    singleton_url: "singleton",
    singleton_sha256: "b5bb9d8014a0f9b1d61e21e796d78dccdf1352f23cd32812f4850b878ae4944c",
    yanked,
  });
  const client = new RappStoreClient({
    url: "store",
    recallMaxAgeMs,
    now: () => clock,
    fetchImpl: async (url) => {
      if (url === "store") {
        catalogFetches += 1;
        if (failCatalog) throw new Error("fetch failed: publisher unreachable");
        return {
          ok: true,
          status: 200,
          json: async () => ({ schema: "rapp-store/1.0", rapplications: [entry()] }),
        };
      }
      return { ok: true, status: 200, arrayBuffer: async () => Buffer.from("foo\n") };
    },
  });
  return {
    client,
    advance: (ms) => { clock += ms; },
    yank: () => { yanked = true; },
    failCatalog: () => { failCatalog = true; },
    fetches: () => catalogFetches,
  };
}

test("a recall reaches a launcher whose catalog was loaded long ago", async () => {
  const store = recallStore();
  await store.client.list();
  assert.equal(store.fetches(), 1);
  assert.equal((await store.client.download("demo")).id, "demo");
  assert.equal(store.fetches(), 1, "within the recall window the cached catalog vouches");

  store.yank();
  store.advance(61_000);
  await assert.rejects(store.client.download("demo"), (error) => error.code === "yanked");
  assert.equal(store.fetches(), 2, "past the window the catalog is re-read before running anything");
});

test("a stale catalog that cannot be revalidated fails closed for downloads but still browses", async () => {
  const store = recallStore();
  await store.client.list();
  store.advance(61_000);
  store.failCatalog();
  await assert.rejects(store.client.download("demo"), /publisher unreachable/);
  assert.equal((await store.client.list()).length, 1, "browsing the cached list still works");
});

test("a backward clock step forces catalog revalidation", async () => {
  const store = recallStore();
  await store.client.list();
  store.yank();
  store.advance(-60 * 60 * 1000);

  await assert.rejects(
    store.client.download("demo"),
    (error) => error.code === "yanked",
  );

  assert.equal(store.fetches(), 2);
});

test("the store timeout covers a body that stalls after the headers arrived", async () => {
  const catalog = {
    schema: "rapp-store/1.0",
    rapplications: [{
      id: "stall",
      name: "Stall",
      version: "1.0.0",
      singleton_filename: "stall_agent.py",
      singleton_url: "singleton",
      singleton_sha256: "b5bb9d8014a0f9b1d61e21e796d78dccdf1352f23cd32812f4850b878ae4944c",
    }],
  };
  const client = new RappStoreClient({
    url: "store",
    timeoutMs: 50,
    fetchImpl: async (url, { signal }) => {
      if (url === "store") return { ok: true, status: 200, json: async () => catalog };
      // Headers arrive at once; the body never does unless the caller aborts.
      return {
        ok: true,
        status: 200,
        arrayBuffer: () => new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted: body stalled")), { once: true });
        }),
      };
    },
  });
  const started = Date.now();
  await assert.rejects(client.download("stall"), /aborted: body stalled/);
  assert.ok(Date.now() - started < 2_000, "the stall is cut by the timeout, not by the test harness");
});
