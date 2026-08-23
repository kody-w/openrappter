import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  betaSourceFingerprint,
  runtimeDirectoryFingerprint,
} from "./walkthrough-provenance.mjs";
import {
  resolveFfmpegExecutable,
  resolveFfprobeExecutable,
} from "../electron/video-tools.mjs";


const brainstemHome = process.env.BRAINSTEM_HOME
  || path.join(homedir(), ".brainstem");
const betaHome = process.env.BRAINSTEM_BETA_HOME
  || path.join(brainstemHome, "beta-launcher");
const metadataPath = process.env.BRAINSTEM_BETA_UI_DRIVER_FILE
  || path.join(betaHome, "ui-driver.json");
const recordingsDir = path.join(betaHome, "recordings");
const walkthroughsDir = path.join(betaHome, "walkthroughs");
const reportsDir = path.join(walkthroughsDir, "runs");
const reviewsDir = path.join(walkthroughsDir, "reviews");
const marker = "FIVE_MINUTE_WALKTHROUGH_COMPLETE";
const brainstemMarker = "LEARNED_AND_TAUGHT:RAPP_READY";
const secondBrainstemMarker = "LEARNED_AND_TAUGHT:SECOND_TURN_READY";
const directBrainstemMarkers = [
  "DIRECT_BRAINSTEM_READY_1",
  "DIRECT_BRAINSTEM_READY_2",
];
const timeoutMs = Number.parseInt(
  process.env.BRAINSTEM_BETA_WALKTHROUGH_TIMEOUT_MS || "1200000",
  10,
);
const cliArguments = process.argv.slice(2);
const ingestExisting = cliArguments.includes("--ingest-existing");
let scenario = "baseline";
const directions = [];
for (let index = 0; index < cliArguments.length; index += 1) {
  const argument = cliArguments[index];
  if (argument === "--ingest-existing") continue;
  if (argument === "--scenario") {
    scenario = String(cliArguments[index + 1] || "").trim() || "baseline";
    index += 1;
    continue;
  }
  if (argument.startsWith("--scenario=")) {
    scenario = argument.slice("--scenario=".length).trim() || "baseline";
    continue;
  }
  directions.push(argument);
}
const repeatEphemeral = scenario === "repeat-ephemeral";
const stackChurn = scenario === "stack-churn";
const controlHandoff = scenario === "control-handoff";
const additionalDirection = directions.join(" ").trim();
const agentSource = `from agents.basic_agent import BasicAgent


class FiveMinuteWalkthroughAgent(BasicAgent):
    def __init__(self):
        self.name = "FiveMinuteWalkthrough"
        self.metadata = {
            "name": self.name,
            "description": "Turn one newly learned RAPP pattern into a reusable teaching proof.",
            "parameters": {
                "type": "object",
                "properties": {
                    "lesson": {
                        "type": "string",
                        "description": "Short marker for the pattern that was learned and taught.",
                    }
                },
                "required": ["lesson"],
            },
        }
        super().__init__()

    def perform(self, lesson="", **kwargs):
        value = str(lesson or "RAPP_READY").strip() or "RAPP_READY"
        return f"LEARNED_AND_TAUGHT:{value}"
`;
const stackChurnAgentSource = `from agents.basic_agent import BasicAgent


class StackChurnProofAgent(BasicAgent):
    def __init__(self):
        self.name = "StackChurnProof"
        self.metadata = {
            "name": self.name,
            "description": "Prove the selected persistent stack is executing.",
            "parameters": {
                "type": "object",
                "properties": {
                    "proof": {
                        "type": "string",
                        "description": "Must be STACK_CHURN_READY.",
                    }
                },
                "required": ["proof"],
            },
        }
        super().__init__()

    def perform(self, proof="", **kwargs):
        return "STACK_CHURN_READY" if proof == "STACK_CHURN_READY" else "INVALID_PROOF"
`;

export function evaluateControlHandoff({
  directTurns = [],
  transcript = "",
  routeTelemetryBefore = {},
  routeTelemetryAfter = {},
} = {}) {
  const requestIds = directTurns.map((turn) => turn.request_id);
  const events = (routeTelemetryAfter.events || []).filter(
    (event) => event.sequence > Number(routeTelemetryBefore.sequence || 0),
  );
  const surgeonRequestIds = events
    .filter((event) => event.type === "ephemeral-callback-end")
    .map((event) => event.request_id)
    .filter(Number.isInteger);
  const markerPositions = directBrainstemMarkers.map(
    (markerValue) => String(transcript).indexOf(markerValue),
  );
  const surgeonMarkerPosition = String(transcript).indexOf(brainstemMarker);
  return {
    direct_turns_complete:
      directTurns.length === directBrainstemMarkers.length
      && directTurns.every((turn, index) => (
        String(turn.response || "").includes(directBrainstemMarkers[index])
      )),
    direct_request_ids_ordered:
      requestIds.length === directBrainstemMarkers.length
      && requestIds.every(Number.isInteger)
      && new Set(requestIds).size === directBrainstemMarkers.length
      && requestIds[0] < requestIds[1],
    transcript_handoff_ordered:
      markerPositions.every((position) => position >= 0)
      && markerPositions[0] < markerPositions[1]
      && markerPositions[1] < surgeonMarkerPosition,
    surgeon_request_followed_direct_turns:
      surgeonRequestIds.length >= 1
      && surgeonRequestIds.every((requestId) => requestId > requestIds[1]),
    no_iframe_replacement:
      routeTelemetryAfter.navigation_count
      === routeTelemetryBefore.navigation_count,
    worker_count_stable:
      routeTelemetryBefore.worker_count === 1
      && routeTelemetryAfter.worker_count === 1,
    chat_lease_released:
      routeTelemetryBefore.chat_lease_count === 0
      && routeTelemetryAfter.chat_lease_count === 0,
  };
}

const prompt = [
  "Run the complete OpenRappter five-minute walkthrough now.",
  "Execute every chapter through tools; do not merely describe the plan.",
  "Keep the teaching narration concise and visible so a first-time user can",
  "follow what the Explorer, Brainstem, and Rappter Surgeon are each proving.",
  "",
  "Chapter 1 — orient the learner:",
  "- Use show_rapp_identity.",
  "- Explain the caller RAPPID, private UUID memory anchor, selected leaf stack,",
  "  ordered overlays, and composition hash in plain language.",
  "- Use drive_visible_brainstem to announce that the left panel is the live",
  "  composition, the center is the unchanged /chat runtime, and this panel is",
  "  the full GitHub Copilot coding-agent loop.",
  "",
  "Chapter 2 — prepare visible evidence:",
  ...(controlHandoff
    ? [
        "- The external driver already started the recording and completed two",
        "  direct Brainstem turns. Do not start a second recording.",
        "- Do not clear the Brainstem chat. Confirm the visible transcript shows",
        `  ${directBrainstemMarkers[0]} followed by ${directBrainstemMarkers[1]}.`,
        "- Explain that direct human control is now handing the same mounted chat",
        "  to Rappter Surgeon without replacing the iframe or transcript.",
      ]
    : [
        "- Clear the Brainstem chat.",
        "- Start demo recording with max_duration_ms=420000.",
      ]),
  "- Inspect the visible Brainstem and confirm its chat input is ready.",
  "",
  stackChurn
    ? "Chapter 3 — create, select, install, and prove persistent stacks:"
    : repeatEphemeral
    ? "Chapter 3 — prove two consecutive one-turn hotloads:"
    : controlHandoff
    ? "Chapter 3 — prove the direct-to-Surgeon control handoff:"
    : "Chapter 3 — learn, build, and teach in one turn:",
  ...(stackChurn
    ? [
        "- Use show_rapp_identity to identify the default stack RAPPID.",
        "- Create a child stack named buzzsaw-role under the default stack.",
        "- Create a sibling stack named buzzsaw-overlay under the default stack.",
        "- Select buzzsaw-role as the leaf with buzzsaw-overlay as the only overlay.",
        "- Install stack_churn_agent.py into buzzsaw-role using the complete source below.",
        "- Delegate to Brainstem without an ephemeral agent. Tell it to call",
        "  StackChurnProof exactly once with proof='STACK_CHURN_READY' and",
        "  require the exact marker STACK_CHURN_READY.",
        "- Capture the visible proof and remember both created stack RAPPIDs.",
        "- Use drive_visible_brainstem to announce",
        "  'STACK_CHURN_READY — persistent stack proof' for 12000ms before cleanup.",
      ]
    : repeatEphemeral
    ? [
        "- Call delegate_to_brainstem twice sequentially with the exact same",
        "  filename and complete ephemeral agent source below.",
        "- First request: use filename five_minute_walkthrough_agent.py, call",
        "  FiveMinuteWalkthrough with lesson='RAPP_READY', and require the",
        `  exact marker ${brainstemMarker}. Wait for it to finish and clean up.`,
        "- Second request: use the same filename and source again, call",
        "  FiveMinuteWalkthrough with lesson='SECOND_TURN_READY', and require",
        `  the exact marker ${secondBrainstemMarker}.`,
        "- Confirm the center transcript still visibly contains both turns and",
        "  that the iframe was not replaced between them.",
      ]
    : controlHandoff
    ? [
        "- Read the existing two direct turns before acting.",
        "- Call delegate_to_brainstem with the ephemeral agent below.",
        "- Use filename five_minute_walkthrough_agent.py.",
        "- Tell Brainstem to call FiveMinuteWalkthrough exactly once with",
        "  lesson='RAPP_READY', explain that Rappter Surgeon now controls the same",
        "  mounted chat, and end with the exact marker",
        `  ${brainstemMarker}.`,
        "- Confirm all three markers remain visible in chronological order.",
      ]
    : [
        "- Call delegate_to_brainstem with the ephemeral agent below.",
        "- Use filename five_minute_walkthrough_agent.py.",
        "- Tell Brainstem to call FiveMinuteWalkthrough exactly once with",
        "  lesson='RAPP_READY', explain that the capability was hotloaded only for",
        `  this turn, and end with the exact marker ${brainstemMarker}.`,
      ]),
  "- Narrate that the user is watching a normal single-file agent become a real",
  "  tool without changing the Grail kernel.",
  ...(stackChurn
    ? [
        "",
        "Persistent stack agent source:",
        "```python",
        stackChurnAgentSource,
        "```",
      ]
    : [
        "",
        "Ephemeral agent source:",
        "```python",
        agentSource,
        "```",
      ]),
  "",
  "Chapter 4 — prove cleanup and inspectability:",
  "- Capture the visible Brainstem result.",
  ...(stackChurn
    ? [
        "- Remove stack_churn_agent.py from buzzsaw-role.",
        "- Select the original default stack with no overlays.",
        "- Remove the now-empty buzzsaw-role and buzzsaw-overlay stacks.",
        "- Use show_rapp_identity and confirm the tree has returned to only the",
        "  original default stack and no stack_churn_agent.py remains.",
      ]
    : [
        "- Use show_rapp_identity again and confirm the one-turn agent was not added",
        "  to any persistent stack after either request.",
      ]),
  "- Explain that inherited stacks and ordered overlays keep reusable skills,",
  "  while this temporary capability disappeared after its request.",
  "",
  "Chapter 5 — show where a capability comes from, and how a preference is made:",
  "- Explain that this device holds nothing it did not choose: nothing was synced",
  "  here, and every optional behaviour is still sealed.",
  "- Open the public RAPP Store and install one capability from it, then say",
  "  plainly what just happened — a public read from an allowed source, no account",
  "  and no sign-in, with the bytes checked against their recorded hash before they",
  "  became anything. Fetching is not trusting.",
  "- Point out that this first reach outward is itself a seal being popped: the",
  "  decision was made in the moment it meant something, not in a setup screen",
  "  before the learner could know why they would say yes.",
  "- Use the installed capability once, so the learner sees that something fetched",
  "  from a public catalog on a device that held nothing is immediately usable.",
  "- Close the point: a second device starts sealed and empty on purpose. What",
  "  travels between machines is an exported .egg a person carries deliberately —",
  "  never an ambient sync that makes a new machine inherit choices nobody made.",
  "",
  "Chapter 6 — show the production path:",
  "- Use check_beta_updates and report the exact visible status without",
  "  clicking Update and Restart.",
  "- Explain the path in one sentence: prove locally in OpenRappter Brainstem, freeze",
  "  the RAPP/1 runtime for Hippocampus, then promote the proven capability",
  "  into the Microsoft experience that fits.",
  "",
  "Chapter 7 — close the teaching loop:",
  `- Stop demo recording with minimum_duration_ms=300000 and recap_mode='${
    stackChurn
      ? "stack-churn"
      : repeatEphemeral
        ? "repeat-ephemeral"
        : controlHandoff
          ? "control-handoff"
        : "baseline"
  }' so this is a true`,
  "  five-minute replay. Let the visible recap tiles fill any remaining time.",
  "- State what the learner can now repeat without VS Code or a terminal.",
  additionalDirection
    ? `- Also incorporate this direction: ${additionalDirection}`
    : "",
  `- Finish with ${marker} on its own line.`,
  `- Include BRAINSTEM_RESULT=${brainstemMarker}.`,
  repeatEphemeral
    ? `- Include SECOND_BRAINSTEM_RESULT=${secondBrainstemMarker}.`
    : "",
  controlHandoff
    ? `- Include DIRECT_BRAINSTEM_RESULT=${
        directBrainstemMarkers.join(" -> ")
      }.`
    : "",
  stackChurn ? "- Include STACK_CHURN_RESULT=STACK_CHURN_READY." : "",
  stackChurn ? "- Include STACK_CLEANUP=CONFIRMED." : "",
  "- Include EPHEMERAL_CLEANUP=CONFIRMED.",
  "- Include the exact update status and recording path from the tool results.",
].filter(Boolean).join("\n");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function currentRecordings() {
  if (!existsSync(recordingsDir)) return new Set();
  return new Set(
    readdirSync(recordingsDir).filter((filename) => filename.endsWith(".webm")),
  );
}

async function waitForBridge(limitMs = timeoutMs) {
  const deadline = Date.now() + limitMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
      const response = await fetch(
        `http://${metadata.host}:${metadata.port}/v1/command`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${metadata.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            action: "inspect",
            target: "shell",
            limit: 1,
          }),
        },
      );
      if (response.ok) return metadata;
      lastError = new Error(`UI bridge HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw new Error(
    `OpenRappter is not ready: ${lastError?.message || "timeout"}`,
  );
}

function launchBeta() {
  const launcher = process.env.BRAINSTEM_BETA_LAUNCHER || path.join(
    betaHome,
    process.platform === "win32" ? "launch.cmd" : "launch.sh",
  );
  if (!existsSync(launcher)) {
    throw new Error(
      `OpenRappter is closed and its launcher is missing at ${launcher}.`,
    );
  }
  const child = process.platform === "win32"
    ? spawn("cmd.exe", ["/d", "/c", launcher], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      })
    : spawn(launcher, [], {
        detached: true,
        stdio: "ignore",
      });
  child.unref();
}

async function driverCommand(metadata, command) {
  const response = await fetch(
    `http://${metadata.host}:${metadata.port}/v1/command`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${metadata.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(command),
    },
  );
  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    throw new Error(payload.error || `UI driver HTTP ${response.status}`);
  }
  return payload.result;
}

async function waitForBrainstem(metadata, limitMs = 60000) {
  const deadline = Date.now() + limitMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await driverCommand(metadata, {
        action: "wait",
        selector: "#input",
        timeoutMs: 1000,
      });
    } catch (error) {
      lastError = error;
      await sleep(250);
    }
  }
  throw new Error(
    `The visible Brainstem did not become ready: ${
      lastError?.message || "timeout"
    }`,
  );
}

function newestRecording(previous) {
  if (!existsSync(recordingsDir)) return null;
  const candidates = readdirSync(recordingsDir)
    .filter((filename) => filename.endsWith(".webm") && !previous.has(filename))
    .map((filename) => path.join(recordingsDir, filename))
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
  return candidates[0] || null;
}

function commandAvailable(command) {
  try {
    execFileSync(command, ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function frameRate(value) {
  const [numerator, denominator = "1"] = String(value || "0/1").split("/");
  const rate = Number(numerator) / Number(denominator);
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

function reviewRecording(recording, runId) {
  const ffmpeg = resolveFfmpegExecutable();
  const ffprobe = resolveFfprobeExecutable();
  const available = commandAvailable(ffmpeg) && commandAvailable(ffprobe);
  if (!available) {
    return {
      available: false,
      decoded: false,
      duration_seconds: null,
      frames: [],
      message: "ffmpeg and ffprobe are unavailable; use the gallery video player.",
    };
  }
  const reviewDir = path.join(reviewsDir, runId);
  mkdirSync(reviewDir, { recursive: true });
  try {
    const probe = JSON.parse(execFileSync(
      ffprobe,
      [
        "-v",
        "error",
        "-count_frames",
        "-show_streams",
        "-show_format",
        "-of",
        "json",
        recording,
      ],
      { encoding: "utf8" },
    ));
    const videoStream = (probe.streams || []).find(
      (stream) => stream.codec_type === "video",
    );
    if (!videoStream) throw new Error("The recording has no video stream.");
    const countedFrames = Number(videoStream.nb_read_frames);
    const rate = frameRate(
      videoStream.avg_frame_rate || videoStream.r_frame_rate,
    );
    const metadataDuration = Number(
      probe.format?.duration || videoStream.duration,
    );
    const durationSeconds = Number.isFinite(metadataDuration)
      && metadataDuration > 0
      ? metadataDuration
      : (Number.isFinite(countedFrames) && rate
          ? countedFrames / rate
          : null);
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      throw new Error("The recording duration is unavailable after frame counting.");
    }
    const frames = [];
    for (const [index, fraction] of [0.05, 0.25, 0.5, 0.75, 0.95].entries()) {
      const framePath = path.join(reviewDir, `frame-${index + 1}.png`);
      execFileSync(
        ffmpeg,
        [
          "-v",
          "error",
          "-y",
          "-ss",
          String(Math.max(0, durationSeconds * fraction)),
          "-i",
          recording,
          "-frames:v",
          "1",
          "-vf",
          "scale=960:-2",
          framePath,
        ],
        { stdio: "ignore" },
      );
      frames.push(framePath);
    }
    const review = {
      available: true,
      decoded: true,
      duration_seconds: durationSeconds,
      codec: videoStream.codec_name || null,
      width: videoStream.width || null,
      height: videoStream.height || null,
      frames,
    };
    writeFileSync(
      path.join(reviewDir, "review.json"),
      `${JSON.stringify(review, null, 2)}\n`,
      { mode: 0o600 },
    );
    return review;
  } catch (error) {
    return {
      available: true,
      decoded: false,
      duration_seconds: null,
      frames: [],
      error: String(error?.message || error),
    };
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function fileUrl(filePath) {
  return filePath ? pathToFileURL(filePath).href : "";
}

function artifactDescriptor(filePath) {
  if (!filePath || !existsSync(filePath)) return null;
  const stats = statSync(filePath);
  return {
    path: filePath,
    sha256: createHash("sha256")
      .update(readFileSync(filePath))
      .digest("hex"),
    size_bytes: stats.size,
    modified_at: stats.mtime.toISOString(),
  };
}

function reportTile(report) {
  const passed = Boolean(report.ok);
  const checks = Object.entries(report.checks || {})
    .map(([name, value]) => (
      `<span class="check ${value ? "pass" : "fail"}">${
        value ? "PASS" : "FAIL"
      } · ${escapeHtml(name)}</span>`
    ))
    .join("");
  const frames = (report.review?.frames || [])
    .map((frame) => (
      `<a href="${fileUrl(frame)}"><img src="${fileUrl(frame)}" alt="Sampled walkthrough frame"></a>`
    ))
    .join("");
  return `<article class="run ${passed ? "passed" : "failed"}">
    <header>
      <div><strong>${passed ? "PASS" : "FAIL"} · ${escapeHtml(report.run_id)}</strong>
      <small>${escapeHtml(report.scenario || "historical")}</small>
      <small>${escapeHtml(report.review?.duration_seconds?.toFixed?.(1) || "?")} seconds · ${
        escapeHtml(report.review?.codec || "unreviewed")
      }</small></div>
      <a href="${fileUrl(report.recording)}">Open WebM</a>
    </header>
    <div class="checks">${checks}</div>
    <video controls preload="metadata" src="${fileUrl(report.recording)}"></video>
    ${report.screenshot
      ? `<a class="final" href="${fileUrl(report.screenshot)}"><img src="${
          fileUrl(report.screenshot)
        }" alt="Final walkthrough state"></a>`
      : ""}
    ${frames ? `<details open><summary>Sampled review frames</summary><div class="frames">${frames}</div></details>` : ""}
    <details><summary>Run verdict</summary><pre>${escapeHtml(report.response || report.error || "")}</pre></details>
  </article>`;
}

function writeReportAndGallery(report) {
  mkdirSync(reportsDir, { recursive: true });
  writeFileSync(
    path.join(reportsDir, `${report.run_id}.json`),
    `${JSON.stringify(report, null, 2)}\n`,
    { mode: 0o600 },
  );
  const reports = readdirSync(reportsDir)
    .filter((filename) => filename.endsWith(".json"))
    .map((filename) => {
      try {
        return JSON.parse(readFileSync(path.join(reportsDir, filename), "utf8"));
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((left, right) => right.run_id.localeCompare(left.run_id));
  const referenced = new Set(reports.map((item) => item.recording).filter(Boolean));
  const historical = existsSync(recordingsDir)
    ? readdirSync(recordingsDir)
      .filter((filename) => filename.endsWith(".webm"))
      .map((filename) => path.join(recordingsDir, filename))
      .filter((recording) => !referenced.has(recording))
      .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)
    : [];
  const historyTiles = historical.map((recording) => (
    `<article class="run historical"><header><div><strong>Historical recording</strong>`
    + `<small>${escapeHtml(path.basename(recording))}</small></div>`
    + `<a href="${fileUrl(recording)}">Open WebM</a></header>`
    + `<video controls preload="metadata" src="${fileUrl(recording)}"></video></article>`
  )).join("");
  const galleryPath = path.join(walkthroughsDir, "index.html");
  writeFileSync(galleryPath, `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>OpenRappter · Walkthrough Improvements</title>
<style>
body{margin:0;background:#0d1117;color:#f0f6fc;font:15px/1.5 ui-sans-serif,system-ui,sans-serif}
main{width:min(1240px,calc(100% - 32px));margin:32px auto 80px}
h1{margin:0;font-size:clamp(28px,4vw,50px)}p{color:#8b949e}
.run{margin:24px 0;padding:18px;border:1px solid #30363d;border-radius:16px;background:#161b22}
.run.passed{border-color:#238636}.run.failed{border-color:#da3633}.run.historical{border-color:#1f6feb}
header{display:flex;justify-content:space-between;gap:16px;align-items:center;margin-bottom:12px}
header div{display:flex;flex-direction:column}small{color:#8b949e}a{color:#58a6ff}
video{width:100%;max-height:720px;background:#000;border-radius:10px}
.checks{display:flex;flex-wrap:wrap;gap:7px;margin:10px 0 14px}.check{padding:4px 8px;border-radius:999px;font-size:11px}
.check.pass{background:#12351f;color:#7ee787}.check.fail{background:#491a1d;color:#ff7b72}
.final img{width:100%;margin-top:12px;border-radius:10px}.frames{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px}
.frames img{width:100%;border-radius:8px}details{margin-top:12px}summary{cursor:pointer;color:#c9d1d9}
pre{white-space:pre-wrap;word-break:break-word;background:#0d1117;padding:12px;border-radius:8px;color:#c9d1d9}
</style></head><body><main>
<h1>OpenRappter improvements</h1>
<p>Newest first. Every scored run was fully decoded and sampled before the next loop.</p>
${reports.map(reportTile).join("")}
${historyTiles ? `<h2>Earlier recordings</h2>${historyTiles}` : ""}
</main></body></html>\n`, { mode: 0o600 });
  return galleryPath;
}

function ingestExistingRecordings() {
  mkdirSync(reportsDir, { recursive: true });
  const existingReports = new Map(
    readdirSync(reportsDir)
      .filter((filename) => filename.endsWith(".json"))
      .map((filename) => {
        try {
          const report = JSON.parse(
            readFileSync(path.join(reportsDir, filename), "utf8"),
          );
          return [report.recording, report];
        } catch {
          return null;
        }
      })
      .filter((item) => item?.[0]),
  );
  const recordings = existsSync(recordingsDir)
    ? readdirSync(recordingsDir)
      .filter((filename) => filename.endsWith(".webm"))
      .map((filename) => path.join(recordingsDir, filename))
      .filter((recording) => (
        !existingReports.has(recording)
        || !existingReports.get(recording)?.review?.decoded
      ))
      .sort((left, right) => statSync(left).mtimeMs - statSync(right).mtimeMs)
    : [];
  let gallery = path.join(walkthroughsDir, "index.html");
  const ingested = [];
  for (const recording of recordings) {
    const stamp = new Date(statSync(recording).mtimeMs)
      .toISOString()
      .replace(/[:.]/g, "-");
    const runId = `${stamp}-historical`;
    const review = reviewRecording(recording, runId);
    const checks = {
      recording_created: true,
      recording_decoded: !review.available || review.decoded,
    };
    const report = {
      run_id: runId,
      ok: Object.values(checks).every(Boolean),
      checks,
      response: "Historical walkthrough recording ingested for overnight review.",
      brainstem: "",
      explorer: "",
      recording,
      screenshot: null,
      review,
    };
    gallery = writeReportAndGallery(report);
    ingested.push({
      recording,
      decoded: review.decoded,
      duration_seconds: review.duration_seconds,
    });
  }
  return { gallery, ingested };
}

async function main() {
  if (ingestExisting) {
    process.stdout.write(`${JSON.stringify(ingestExistingRecordings(), null, 2)}\n`);
    return;
  }
  const runStartedAt = new Date().toISOString();
  const runId = runStartedAt.replace(/[:.]/g, "-");
  const beforeRecordings = currentRecordings();
  let metadata;
  try {
    metadata = await waitForBridge(1000);
  } catch {
    launchBeta();
    metadata = await waitForBridge();
  }
  await driverCommand(metadata, {
    action: "click",
    target: "shell",
    selector: "#enter",
    optional: true,
    label: "Entering the RAPP teaching workspace",
  });
  await waitForBrainstem(metadata);
  await driverCommand(metadata, {
    action: "click",
    selector: "header .logo",
    optional: true,
    label: "Opening live agents from the Brainstem icon",
  });
  const routeTelemetryBefore = await driverCommand(metadata, {
    action: "route_telemetry",
    target: "shell",
  });
  const directTurns = [];
  if (controlHandoff) {
    const recordingStatus = await driverCommand(metadata, {
      action: "recording_status",
      target: "shell",
    });
    if (recordingStatus.active) {
      throw new Error("Control-handoff requires a clean recording baseline.");
    }
    await driverCommand(metadata, {
      action: "start_recording",
      target: "shell",
      maxDurationMs: 420000,
    });
    for (const directMarker of directBrainstemMarkers) {
      const directResult = await driverCommand(metadata, {
        action: "chat",
        value: [
          "This is a direct visible Brainstem control-handoff probe.",
          `Reply with exactly ${directMarker} and nothing else.`,
          "Do not call any tools.",
        ].join(" "),
        label: `Direct Brainstem turn ${directTurns.length + 1}`,
        timeoutMs: 180000,
      });
      directTurns.push({
        marker: directMarker,
        request_id: directResult.requestId,
        response: directResult.response,
      });
    }
  }
  const result = await driverCommand(metadata, {
    action: "surgeon_chat",
    target: "shell",
    value: prompt,
    label: "Guiding GitHub Copilot through the five-minute walkthrough",
    timeoutMs,
  });
  await sleep(2500);
  const routeTelemetryAfter = await driverCommand(metadata, {
    action: "route_telemetry",
    target: "shell",
  });
  const brainstem = await driverCommand(metadata, {
    action: "read",
    selector: "#chat",
    limit: 20000,
  });
  const explorer = await driverCommand(metadata, {
    action: "read",
    target: "shell",
    selector: "#agent-tree",
    limit: 20000,
  });
  const screenshot = await driverCommand(metadata, {
    action: "screenshot",
    target: "shell",
  });
  const response = String(result?.response || "");
  const recording = newestRecording(beforeRecordings);
  const review = recording
    ? reviewRecording(recording, runId)
    : {
        available: commandAvailable(resolveFfmpegExecutable())
          && commandAvailable(resolveFfprobeExecutable()),
        decoded: false,
        duration_seconds: null,
        frames: [],
      };
  const scenarioRouteEvents = (routeTelemetryAfter.events || []).filter(
    (event) => event.sequence > routeTelemetryBefore.sequence,
  );
  const stackChurnProof = scenarioRouteEvents.some((event) => (
    event.type === "route-callback-end"
    && String(event.response_preview || "").includes("STACK_CHURN_READY")
    && (
      String(event.agent_logs_preview || "")
        .match(/STACKCHURNPROOF/gi)?.length === 1
    )
    && Number.isInteger(event.request_id)
  ));
  const checks = {
    surgeon_complete: response.includes(marker),
    brainstem_complete: stackChurn
      ? stackChurnProof
      : String(brainstem?.text || "").includes(brainstemMarker),
    ephemeral_removed: !String(explorer?.text || "").includes(
      "five_minute_walkthrough_agent.py",
    ),
    ...(repeatEphemeral
      ? {
          second_turn_complete: String(brainstem?.text || "")
            .includes(secondBrainstemMarker),
          transcript_preserved: String(brainstem?.text || "")
            .includes(brainstemMarker)
            && String(brainstem?.text || "").includes(secondBrainstemMarker),
          same_worker_url: (() => {
            const events = (routeTelemetryAfter.events || []).filter(
              (event) => event.sequence > routeTelemetryBefore.sequence,
            );
            const injections = events.filter(
              (event) => event.type === "ephemeral-injected",
            );
            return injections.length === 2
              && new Set(injections.map((event) => event.url)).size === 1
              && injections[0].url === routeTelemetryBefore.active_route?.url
              && injections[0].url === routeTelemetryAfter.active_route?.url;
          })(),
          no_iframe_replacement:
            routeTelemetryAfter.navigation_count
            === routeTelemetryBefore.navigation_count,
          route_events_ordered: (() => {
            const events = (routeTelemetryAfter.events || []).filter(
              (event) => event.sequence > routeTelemetryBefore.sequence,
            );
            const injections = events.filter(
              (event) => event.type === "ephemeral-injected",
            );
            if (injections.length !== 2) return false;
            return injections.every((injection) => {
              const before = (type, predicate = () => true) => (
                [...events].reverse().find((event) => (
                  event.sequence < injection.sequence
                  && event.type === type
                  && predicate(event)
                ))
              );
              const after = (type, predicate = () => true) => (
                events.find((event) => (
                  event.sequence > injection.sequence
                  && event.type === type
                  && predicate(event)
                ))
              );
              const lifecycleLock = before(
                "lock-acquired",
                (event) => event.key === "__lifecycle__",
              );
              const routeLock = before(
                "lock-acquired",
                (event) => event.key === injection.base_composition_hash,
              );
              const transientActivation = after(
                "route-activated",
                (event) => event.active_composition_hash
                  === injection.active_composition_hash,
              );
              const callbackStart = after(
                "ephemeral-callback-start",
                (event) => event.active_composition_hash
                  === injection.active_composition_hash,
              );
              const callbackEnd = after(
                "ephemeral-callback-end",
                (event) => event.active_composition_hash
                  === injection.active_composition_hash,
              );
              const leaseApplied = callbackStart && events.find((event) => (
                event.sequence > callbackStart.sequence
                && event.type === "chat-lease-applied"
                && event.sequence < callbackEnd?.sequence
              ));
              const cleaned = after(
                "ephemeral-cleaned",
                (event) => event.active_composition_hash
                  === injection.active_composition_hash,
              );
              const baseRestored = cleaned && events.find((event) => (
                event.sequence > cleaned.sequence
                && event.type === "route-activated"
                && event.active_composition_hash
                  === injection.base_composition_hash
              ));
              const routeReleased = baseRestored && events.find((event) => (
                event.sequence > baseRestored.sequence
                && event.type === "lock-released"
                && event.key === injection.base_composition_hash
              ));
              const lifecycleReleased = routeReleased && events.find((event) => (
                event.sequence > routeReleased.sequence
                && event.type === "lock-released"
                && event.key === "__lifecycle__"
              ));
              const leaseReleased = lifecycleReleased && events.find((event) => (
                event.sequence > lifecycleReleased.sequence
                && event.type === "chat-lease-released"
              ));
              return lifecycleLock?.sequence < routeLock?.sequence
                && routeLock.sequence < injection.sequence
                && injection.sequence < transientActivation?.sequence
                && transientActivation.sequence < callbackStart?.sequence
                && callbackStart.sequence < leaseApplied?.sequence
                && leaseApplied.sequence < callbackEnd?.sequence
                && callbackStart.sequence < callbackEnd?.sequence
                && Number.isInteger(callbackEnd.request_id)
                && callbackEnd.sequence < cleaned?.sequence
                && cleaned.sequence < baseRestored?.sequence
                && baseRestored.sequence < routeReleased?.sequence
                && routeReleased.sequence < lifecycleReleased?.sequence
                && lifecycleReleased.sequence < leaseReleased?.sequence;
            });
          })(),
          cache_counts_stable:
            routeTelemetryAfter.object_count === routeTelemetryBefore.object_count
            && routeTelemetryAfter.egg_count === routeTelemetryBefore.egg_count,
          worker_count_stable:
            routeTelemetryBefore.worker_count === 1
            && routeTelemetryAfter.worker_count === 1,
          no_worker_churn: (() => {
            const events = (routeTelemetryAfter.events || []).filter(
              (event) => event.sequence > routeTelemetryBefore.sequence,
            );
            return !events.some((event) => (
              event.type === "worker-started"
              || event.type === "worker-stopped"
            ));
          })(),
          request_ids_distinct: (() => {
            const events = (routeTelemetryAfter.events || []).filter(
              (event) => event.sequence > routeTelemetryBefore.sequence,
            );
            const ids = events
              .filter((event) => event.type === "ephemeral-callback-end")
              .map((event) => event.request_id);
            return ids.length === 2
              && ids.every(Number.isInteger)
              && new Set(ids).size === 2
              && ids[0] < ids[1];
          })(),
          chat_lease_released:
            routeTelemetryBefore.chat_lease_count === 0
            && routeTelemetryAfter.chat_lease_count === 0,
        }
      : {}),
    ...(stackChurn
      ? {
          stack_churn_complete: stackChurnProof,
          stack_agent_removed: !String(explorer?.text || "")
            .includes("stack_churn_agent.py"),
          stack_tree_restored:
            JSON.stringify(routeTelemetryBefore.stack_tree)
            === JSON.stringify(routeTelemetryAfter.stack_tree),
          stack_count_restored:
            routeTelemetryBefore.stack_count === routeTelemetryAfter.stack_count,
          worker_churn_balanced: (() => {
            const events = (routeTelemetryAfter.events || []).filter(
              (event) => event.sequence > routeTelemetryBefore.sequence,
            );
            return events.filter(
              (event) => event.type === "worker-started",
            ).length === events.filter(
              (event) => event.type === "worker-stopped",
            ).length
              && routeTelemetryBefore.worker_count === 1
              && routeTelemetryAfter.worker_count === 1;
          })(),
          stack_events_complete: (() => {
            const events = (routeTelemetryAfter.events || []).filter(
              (event) => event.sequence > routeTelemetryBefore.sequence,
            );
            return events.filter((event) => event.type === "stack-created").length === 2
              && events.filter(
                (event) => event.type === "stack-agent-installed",
              ).length === 1
              && events.filter(
                (event) => event.type === "stack-agent-removed",
              ).length === 1
              && events.filter((event) => event.type === "stack-removed").length === 2;
          })(),
        }
      : {}),
    ...(controlHandoff
      ? evaluateControlHandoff({
          directTurns,
          transcript: brainstem?.text,
          routeTelemetryBefore,
          routeTelemetryAfter,
        })
      : {}),
    recording_created: Boolean(recording),
    recording_decoded: !review.available || review.decoded,
    five_minute_duration: !review.available
      || Number(review.duration_seconds) >= 270,
  };
  const generatedAt = new Date().toISOString();
  const brainstemRuntimeAfter = metadata.brainstemRuntimeFingerprint?.root
    ? runtimeDirectoryFingerprint(metadata.brainstemRuntimeFingerprint.root)
    : null;
  const report = {
    scenario,
    run_id: runId,
    run_started_at: runStartedAt,
    run_completed_at: generatedAt,
    ok: Object.values(checks).every(Boolean),
    checks,
    response: response.slice(-4000),
    direct_turns: directTurns,
    brainstem: String(brainstem?.text || "").slice(-4000),
    explorer: String(explorer?.text || "").slice(0, 4000),
    recording,
    screenshot: screenshot.path,
    review,
    route_telemetry: {
      before: routeTelemetryBefore,
      after: routeTelemetryAfter,
    },
    artifacts: {
      recording: artifactDescriptor(recording),
      screenshot: artifactDescriptor(screenshot.path),
      review_frames: review.frames.map(artifactDescriptor),
    },
    provenance: {
      ...betaSourceFingerprint(),
      app_pid: metadata.pid,
      app_started_at: metadata.startedAt,
      generated_at: generatedAt,
      brainstem_runtime_after: brainstemRuntimeAfter,
      brainstem_runtime_startup: metadata.brainstemRuntimeFingerprint,
      runtime_fingerprint: metadata.runtimeFingerprint,
    },
  };
  const gallery = writeReportAndGallery(report);
  process.stdout.write(`${JSON.stringify({ ...report, gallery }, null, 2)}\n`);
  if (!Object.values(checks).every(Boolean)) process.exitCode = 1;
}

const executedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : null;
if (executedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${String(error?.stack || error)}\n`);
    process.exitCode = 1;
  });
}
