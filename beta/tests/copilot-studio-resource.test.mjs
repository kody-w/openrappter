import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const resourceUrl = new URL(
  "../resources/copilot-studio/rar_kody_w_copilot_studio_parity_deploy_agent.py",
  import.meta.url,
);
const factoryResourceUrl = new URL(
  "../resources/copilot-studio/rar_kody_w_factory_agent.py",
  import.meta.url,
);

test("bundled parity deploy agent builds an explicit frozen agents package", async () => {
  const source = await readFile(resourceUrl, "utf8");
  assert.match(source, /"version": "1\.0\.14"/);
  assert.match(source, /BETA_DRAFT_ONLY = True/);
  assert.match(source, /self\.name = "CopilotStudioDeployBeta"/);
  assert.match(source, /relative\.parts\[0\] == "runtime"/);
  assert.match(source, /https:\/\/copilotstudio\.preview\.microsoft\.com\/environments\//);
  assert.match(source, /_run\(\["open", "-a", "Microsoft Edge", url\]/);
  assert.match(source, /set targetTab to active tab of targetWindow/);
  assert.match(source, /reload targetTab/);
  assert.match(source, /node\.getAttribute\('href'\)\|\|node\.href/);
  assert.match(source, /Copilot Studio Build view did not become ready/);
  assert.match(source, /Copilot Studio Preview chat did not become ready/);
  assert.match(source, /drop_exact_line/);
  assert.match(source, /package_init = packaged_basic_agent\.parent \/ "__init__\.py"/);
  assert.match(source, /package_init\.write_text\("", encoding="utf-8"\)/);
  assert.match(source, /Live publish is disabled in RAPP Brainstem Frontier/);
});

test("bundled beta Factory cannot be shadowed by generic deployment tools", async () => {
  const source = await readFile(factoryResourceUrl, "utf8");
  assert.match(source, /"version": "1\.0\.4"/);
  assert.match(source, /BETA_DRAFT_ONLY = True/);
  assert.match(source, /self\.name = "RappCopilotStudioFactoryBeta"/);
  assert.ok(
    source.indexOf('"rar_kody_w_copilot_studio_parity_deploy_agent"')
      < source.indexOf('"copilot_studio_deploy_agent"'),
  );
});
