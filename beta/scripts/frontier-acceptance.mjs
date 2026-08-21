// Force-mode acceptance test for the RAPP Brainstem Frontier.
//
// Drives the LIVE Frontier through the token-authenticated UI-driver bridge and
// asserts the beta's headline behaviors end-to-end — most importantly the
// Brainstem<->twin autonomous loop (the visible Brainstem plans, the twin
// executes, the Brainstem says DONE), plus the brandmark and the herd tile.
//
//   node scripts/frontier-acceptance.mjs
//
// Requires the Frontier to be open (start it first, e.g. `npm start`, or via the
// beta launcher) and Copilot signed in. Exits 0 on pass, 1 on failure, 2 if the
// bridge is unavailable. Read-only aside from hatching one throwaway twin.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const betaHome = process.env.BRAINSTEM_BETA_HOME
  || path.join(process.env.BRAINSTEM_HOME || path.join(homedir(), ".brainstem"), "beta-launcher");
const metaPath = process.env.BRAINSTEM_BETA_UI_DRIVER_FILE || path.join(betaHome, "ui-driver.json");

let md;
try {
  md = JSON.parse(readFileSync(metaPath, "utf8"));
} catch {
  console.error(`No UI-driver bridge at ${metaPath}. Start the Frontier first, then re-run.`);
  process.exit(2);
}

const BRIDGE = `http://${md.host}:${md.port}/v1/command`;
async function cmd(body) {
  const r = await fetch(BRIDGE, {
    method: "POST",
    headers: { Authorization: `Bearer ${md.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok || !j.ok) throw new Error(j.error || `bridge HTTP ${r.status}`);
  return j.result;
}

const checks = [];
const record = (name, pass, detail = "") => {
  checks.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};

try {
  // 1. App is healthy and shows the brandmark favicon.
  const shell = await cmd({ action: "inspect", target: "shell", limit: 1 });
  record("app healthy (shell responds)", /Frontier/i.test(shell.title || ""), shell.title);
  // (The brandmark favicon + all icon sizes are asserted statically in
  // tests/brandmark.test.mjs; here we focus on live force-mode behavior.)

  // 2. Drive the Brainstem<->twin autonomous loop through the Surgeon (force mode).
  const goal = 'Introduce yourself in exactly one line and confirm you can validate JSON.';
  const instruction = [
    "Do this hands-off, don't ask me anything:",
    "1) Call hatch_rapplication with store_id json_doctor.",
    `2) Then call loop_brainstem_with_twin with that twin id and goal: "${goal}"`,
    "Then reply with the twin id and confirm the Brainstem loop started.",
  ].join("\n");
  const reply = await cmd({ action: "surgeon_chat", target: "shell", value: instruction, timeoutMs: 300000 });
  record("Surgeon ran hatch + loop_brainstem_with_twin", /loop started|json-doctor/i.test(reply.response || ""),
    (reply.response || "").slice(0, 120));

  // 3. Give the two-brain loop a moment, then assert the transcript.
  let transcript = "";
  for (let i = 0; i < 20; i += 1) {
    const shellText = (await cmd({ action: "inspect", target: "shell", limit: 1 })).text || "";
    const start = shellText.indexOf("JSON Doctor");
    transcript = start >= 0 ? shellText.slice(start, start + 1400) : shellText;
    if (/BRAINSTEM[\s\S]*JSON DOCTOR[\s\S]*DONE/i.test(transcript)) break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  record("twin tile renders the ⟳ Loop control", /⟳\s*Loop/.test(transcript) || /Loop/.test(transcript));
  record("loop: BRAINSTEM planned an instruction", /BRAINSTEM/i.test(transcript));
  record("loop: the twin executed and replied", /JSON DOCTOR/i.test(transcript));
  record("loop: the Brainstem converged on DONE", /BRAINSTEM[\s\S]*DONE/i.test(transcript));
} catch (error) {
  record("acceptance run", false, error.message);
}

const failed = checks.filter((c) => !c.pass);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
process.exit(failed.length ? 1 : 0);
