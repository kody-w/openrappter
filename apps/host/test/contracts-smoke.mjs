import assert from "node:assert/strict";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import * as contracts from "@rapp-work/host/contracts";

const hostRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const schemas = [
  "workspaceSummarySchema", "workspaceTreeSchema", "workspaceChildrenSchema", "workspaceBreadcrumbSchema",
  "workspaceOpenSchema", "twinBasisSchema", "twinDraftSchema", "frameVerificationSchema",
  "twinEvolutionReferencesSchema", "twinEvolutionEventSchema", "agentWorkspaceResultSchema", "twinAgentApplyResultSchema",
  "computerSchema", "computerWorkspaceSchema", "computerLeaseSchema", "computerDisplaySchema",
];
for (const name of schemas) assert.equal(typeof contracts[name]?.parse, "function", `Missing public schema: ${name}`);
const browser = await build({
  absWorkingDir: hostRoot, entryPoints: ["@rapp-work/host/contracts"],
  bundle: true, platform: "browser", format: "esm", write: false, metafile: true, logLevel: "silent",
});
const inputs = Object.keys(browser.metafile.inputs).map((path) => resolve(hostRoot, path));
const contractModule = resolve(hostRoot, "dist/contracts.js");
assert.ok(inputs.includes(contractModule));
assert.ok(inputs.every((path) => path === contractModule || path.includes(`${sep}node_modules${sep}zod${sep}`)),
  "The browser contract entry must not import Node host composition, SDK, or broker code.");
assert.ok(browser.outputFiles[0].contents.byteLength > 0);
console.log(JSON.stringify({
  status: "passed", entryPoint: "@rapp-work/host/contracts", schemas: schemas.length,
  browserBundle: true, hostRuntimeModules: 0,
}));
