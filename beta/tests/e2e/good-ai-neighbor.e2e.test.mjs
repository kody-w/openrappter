import assert from "node:assert/strict";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import path from "node:path";

import { launch } from "./harness/launch.mjs";
import { frontierTest } from "./harness/test-support.mjs";

async function endpoint(app) {
  const file = path.join(app.paths.betaHome, "chat-endpoint.json");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`OpenRappter endpoint did not appear at ${file}.`);
}

async function chat(metadata, prompt) {
  const response = await fetch(metadata.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      user_input: prompt,
    }),
  });
  assert.equal(response.status, 200);
  return response.json();
}

frontierTest("two Good AI Neighbor dock creatures work side by side", async () => {
  let alpha;
  let research;
  try {
    alpha = await launch({
      env: { OPENRAPPTER_DOCK_VISIBLE: "1" },
      modelScript: {
        steps: [{
          when: { index: 1, lastUser: "identify alpha" },
          response: { text: "ALPHA_NEIGHBOR_OK" },
        }],
      },
      scenario: "good-neighbor-alpha",
    });
    research = await launch({
      env: {
        OPENRAPPTER_DOCK_VISIBLE: "1",
        OPENRAPPTER_INSTANCE: "research-twin",
      },
      modelScript: {
        steps: [{
          when: { index: 1, lastUser: "identify research" },
          response: { text: "RESEARCH_NEIGHBOR_OK" },
        }],
      },
      scenario: "good-neighbor-research",
    });

    assert.notEqual(alpha.paths.openRappterHome, research.paths.openRappterHome);
    assert.notEqual(alpha.paths.betaHome, research.paths.betaHome);
    assert.notEqual(alpha.paths.brainstemHome, research.paths.brainstemHome);
    assert.notEqual(alpha.paths.electronUserData, research.paths.electronUserData);
    assert.notEqual(alpha.route.url, research.route.url);

    const alphaEndpoint = await endpoint(alpha);
    const researchEndpoint = await endpoint(research);
    assert.equal(alphaEndpoint.neighborhood_id, "openrappter:alpha");
    assert.equal(alphaEndpoint.app_name, "OpenRappter");
    assert.equal(alphaEndpoint.dock_visible, true);
    assert.equal(
      researchEndpoint.neighborhood_id,
      "openrappter:research-twin",
    );
    assert.equal(researchEndpoint.app_name, "OpenRappter · Research Twin");
    assert.equal(researchEndpoint.dock_badge, "RT");
    assert.equal(researchEndpoint.dock_visible, true);
    assert.notEqual(
      alphaEndpoint.app_user_model_id,
      researchEndpoint.app_user_model_id,
    );
    assert.notEqual(alphaEndpoint.url, researchEndpoint.url);
    assert.equal(
      (await chat(alphaEndpoint, "identify alpha")).response,
      "ALPHA_NEIGHBOR_OK",
    );
    assert.equal(
      (await chat(researchEndpoint, "identify research")).response,
      "RESEARCH_NEIGHBOR_OK",
    );

    const alphaBadge = await alpha.driver.command({
      action: "read",
      selector: "#neighborhood-identity",
      target: "shell",
    });
    const researchBadge = await research.driver.command({
      action: "read",
      selector: "#neighborhood-identity",
      target: "shell",
    });
    assert.match(alphaBadge.text, /Good AI Estate · alpha · 1 neighborhoods?/);
    assert.match(researchBadge.text, /OpenRappter · Research Twin/);
    assert.match(
      researchBadge.text,
      /Good AI Estate · research-twin · 1 neighborhoods?/,
    );

    const alphaIdentity = JSON.parse(readFileSync(
      path.join(alpha.paths.betaHome, "identity", "openrappter.json"),
      "utf8",
    ));
    const researchIdentity = JSON.parse(readFileSync(
      path.join(research.paths.betaHome, "identity", "openrappter.json"),
      "utf8",
    ));
    assert.notEqual(alphaIdentity.rappid, researchIdentity.rappid);
    const agentName = readdirSync(path.join(alpha.paths.grail, "agents"))
      .find((name) => name.endsWith("_agent.py"));
    assert(agentName);
    assert.notEqual(
      statSync(path.join(alpha.paths.grail, "agents", agentName)).ino,
      statSync(path.join(research.paths.grail, "agents", agentName)).ino,
    );
    const alphaTiles = path.join(alpha.paths.betaHome, "tiles");
    const researchTiles = path.join(research.paths.betaHome, "tiles");
    mkdirSync(alphaTiles, { recursive: true });
    writeFileSync(path.join(alphaTiles, "tile-alpha-only.json"), "{}\n");
    assert.equal(
      existsSync(path.join(researchTiles, "tile-alpha-only.json")),
      false,
      "a neighborhood herd cannot see another owner's tile files",
    );
  } finally {
    await Promise.allSettled([alpha?.stop(), research?.stop()]);
  }
});
