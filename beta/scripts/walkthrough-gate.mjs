import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  betaSourceFingerprint,
  runtimeDirectoryFingerprint,
} from "./walkthrough-provenance.mjs";
import { resolveFfprobeExecutable } from "../electron/video-tools.mjs";


const betaHome = process.env.BRAINSTEM_BETA_HOME
  || path.join(
    process.env.BRAINSTEM_HOME || path.join(homedir(), ".brainstem"),
    "beta-launcher",
  );
const walkthroughsDir = path.join(betaHome, "walkthroughs");
const reportsDir = path.join(walkthroughsDir, "runs");
const galleryPath = path.join(walkthroughsDir, "index.html");
const metadataPath = process.env.BRAINSTEM_BETA_UI_DRIVER_FILE
  || path.join(betaHome, "ui-driver.json");
const allowUncertified = process.argv.includes("--allow-uncertified");
const results = [];

function requirement(name, pass, detail = "") {
  const result = { name, pass: Boolean(pass), detail };
  results.push(result);
  process.stdout.write(
    `${result.pass ? " PASS" : "*FAIL"}  ${name}${
      detail ? ` — ${detail}` : ""
    }\n`,
  );
}

function latestScoredReport() {
  if (!existsSync(reportsDir)) return null;
  const candidates = readdirSync(reportsDir)
    .filter((filename) => (
      filename.endsWith(".json") && !filename.includes("-historical")
    ))
    .sort((left, right) => right.localeCompare(left));
  for (const filename of candidates) {
    try {
      return JSON.parse(readFileSync(path.join(reportsDir, filename), "utf8"));
    } catch {}
  }
  return null;
}

function fileSize(filePath) {
  return filePath && existsSync(filePath) ? statSync(filePath).size : 0;
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

function compositionFingerprint(value) {
  if (
    !value?.agent_directory
    || !value?.manifest_path
    || !existsSync(value.agent_directory)
    || !existsSync(value.manifest_path)
  ) {
    return null;
  }
  const files = readdirSync(value.agent_directory)
    .filter((filename) => filename.endsWith(".py"))
    .sort();
  const hash = createHash("sha256");
  for (const filename of files) {
    hash.update(filename);
    hash.update("\0");
    hash.update(readFileSync(path.join(value.agent_directory, filename)));
    hash.update("\0");
  }
  hash.update("complete.json");
  hash.update("\0");
  hash.update(readFileSync(value.manifest_path));
  return {
    files,
    source_hash: hash.digest("hex"),
  };
}

function frameRate(value) {
  const [numerator, denominator = "1"] = String(value || "0/1").split("/");
  const rate = Number(numerator) / Number(denominator);
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

function probeVideo(filePath) {
  const result = spawnSync(
    resolveFfprobeExecutable(),
    [
      "-v",
      "error",
      "-count_frames",
      "-show_streams",
      "-show_format",
      "-of",
      "json",
      filePath,
    ],
    {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr || `ffprobe exited with ${result.status}`);
  }
  const probe = JSON.parse(result.stdout);
  const stream = (probe.streams || []).find(
    (candidate) => candidate.codec_type === "video",
  );
  if (!stream) throw new Error("The recording has no video stream.");
  const metadataDuration = Number(probe.format?.duration || stream.duration);
  const countedFrames = Number(stream.nb_read_frames);
  const rate = frameRate(stream.avg_frame_rate || stream.r_frame_rate);
  return {
    codec: stream.codec_name || null,
    duration_seconds: Number.isFinite(metadataDuration) && metadataDuration > 0
      ? metadataDuration
      : countedFrames / rate,
    height: Number(stream.height) || null,
    width: Number(stream.width) || null,
  };
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function kernelIsUnchanged() {
  const repoRoot = path.resolve(import.meta.dirname, "..", "..");
  const result = spawnSync(
    "git",
    [
      "diff",
      "--exit-code",
      "HEAD",
      "--",
      "rapp_brainstem/brainstem.py",
      "rapp_brainstem/local_storage.py",
      "rapp_brainstem/index.html",
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      windowsHide: true,
    },
  );
  return {
    pass: result.status === 0,
    detail: String(result.stderr || result.stdout || "").trim(),
  };
}

function main() {
  const report = latestScoredReport();
  requirement("latest scored walkthrough exists", Boolean(report), report?.run_id || "");
  if (!report) process.exit(1);

  requirement("walkthrough gate reported green", report.ok === true);
  for (const [name, pass] of Object.entries(report.checks || {})) {
    requirement(`walkthrough check: ${name}`, pass === true);
  }
  const duration = Number(report.review?.duration_seconds);
  requirement(
    "video duration is a true five-minute walkthrough",
    duration >= 270 && duration <= 420,
    `${duration || 0}s`,
  );
  requirement(
    "video fully decoded",
    report.review?.decoded === true,
    report.review?.codec || "",
  );
  requirement(
    "video resolution is reviewable",
    Number(report.review?.width) >= 1280
      && Number(report.review?.width) <= 1920
      && Number(report.review?.height) >= 720,
    `${report.review?.width || 0}x${report.review?.height || 0}`,
  );
  requirement(
    "recording exists and is nontrivial",
    fileSize(report.recording) > 1024 * 1024,
    `${fileSize(report.recording)} bytes`,
  );
  requirement(
    "final screenshot exists",
    fileSize(report.screenshot) > 100 * 1024,
    `${fileSize(report.screenshot)} bytes`,
  );
  const frames = report.review?.frames || [];
  requirement("five review frames exist", frames.length === 5);
  frames.forEach((frame, index) => {
    requirement(
      `review frame ${index + 1} is nonempty`,
      fileSize(frame) > 50 * 1024,
      `${fileSize(frame)} bytes`,
    );
  });
  const artifactEntries = [
    ["recording", report.artifacts?.recording],
    ["screenshot", report.artifacts?.screenshot],
    ...(report.artifacts?.review_frames || []).map(
      (artifact, index) => [`review frame ${index + 1}`, artifact],
    ),
  ];
  const runStarted = Date.parse(report.run_started_at || "");
  const runCompleted = Date.parse(report.run_completed_at || "");
  for (const [name, expected] of artifactEntries) {
    const actual = artifactDescriptor(expected?.path);
    requirement(
      `${name} hash matches report`,
      Boolean(actual && actual.sha256 === expected?.sha256),
      actual?.sha256 || "missing",
    );
    requirement(
      `${name} size matches report`,
      Boolean(actual && actual.size_bytes === expected?.size_bytes),
      `${actual?.size_bytes || 0} bytes`,
    );
    const modified = Date.parse(actual?.modified_at || "");
    requirement(
      `${name} was created during this run`,
      Number.isFinite(modified)
        && Number.isFinite(runStarted)
        && Number.isFinite(runCompleted)
        && modified >= runStarted - 5000
        && modified <= runCompleted + 5000,
      actual?.modified_at || "missing",
    );
  }
  let independentProbe = null;
  try {
    independentProbe = probeVideo(report.recording);
  } catch {}
  requirement(
    "gate independently decodes the recording",
    Boolean(independentProbe),
  );
  requirement(
    "independent duration matches report",
    Math.abs(
      Number(independentProbe?.duration_seconds)
      - Number(report.review?.duration_seconds),
    ) < 1,
    `${independentProbe?.duration_seconds || 0}s`,
  );
  requirement(
    "independent codec and dimensions match report",
    independentProbe?.codec === report.review?.codec
      && independentProbe?.width === report.review?.width
      && independentProbe?.height === report.review?.height,
    `${independentProbe?.codec || "missing"} ${
      independentProbe?.width || 0
    }x${independentProbe?.height || 0}`,
  );
  requirement(
    "Brain Surgeon completed its guided loop",
    String(report.response || "").includes("FIVE_MINUTE_WALKTHROUGH_COMPLETE"),
  );
  if (report.scenario !== "stack-churn") {
    requirement(
      "Brainstem proof survived ephemeral cleanup",
      String(report.brainstem || "").includes("LEARNED_AND_TAUGHT:RAPP_READY"),
    );
  }
  if (report.scenario === "repeat-ephemeral") {
    requirement(
      "second ephemeral turn completed",
      String(report.brainstem || "")
        .includes("LEARNED_AND_TAUGHT:SECOND_TURN_READY"),
    );
    requirement(
      "both ephemeral turns remain in one visible transcript",
      report.checks?.transcript_preserved === true,
    );
    const before = report.route_telemetry?.before;
    const after = report.route_telemetry?.after;
    const events = (after?.events || []).filter(
      (event) => event.sequence > Number(before?.sequence || 0),
    );
    const injections = events.filter(
      (event) => event.type === "ephemeral-injected",
    );
    const cleanups = events.filter(
      (event) => event.type === "ephemeral-cleaned",
    );
    requirement(
      "telemetry proves exactly two ephemeral injections",
      injections.length === 2,
      `${injections.length}`,
    );
    requirement(
      "telemetry proves both turns used one worker URL",
      injections.length === 2
        && new Set(injections.map((event) => event.url)).size === 1
        && injections[0].url === before?.active_route?.url
        && injections[0].url === after?.active_route?.url,
      injections.map((event) => event.url).join(", "),
    );
    requirement(
      "telemetry proves unchanged base composition",
      injections.length === 2
        && injections.every((event) => (
          event.base_composition_hash
            === before?.active_route?.base_composition_hash
          && event.base_composition_hash
            === after?.active_route?.base_composition_hash
        )),
    );
    requirement(
      "telemetry proves request-unique active compositions",
      injections.length === 2
        && new Set(
          injections.map((event) => event.active_composition_hash),
        ).size === 2,
    );
    requirement(
      "telemetry proves two complete cleanups",
      cleanups.length === 2
        && cleanups.every((event) => (
          event.file_exists === false
          && event.manifest_has_ephemeral === false
        )),
      `${cleanups.length}`,
    );
    requirement(
      "telemetry proves no iframe navigation",
      before?.navigation_count === after?.navigation_count,
      `${before?.navigation_count} -> ${after?.navigation_count}`,
    );
    requirement(
      "telemetry proves stable object and egg caches",
      before?.object_count === after?.object_count
        && before?.egg_count === after?.egg_count,
      `objects ${before?.object_count} -> ${after?.object_count}; `
        + `eggs ${before?.egg_count} -> ${after?.egg_count}`,
    );
    requirement(
      "telemetry proves stable single-worker lifecycle",
      before?.worker_count === 1
        && after?.worker_count === 1
        && !events.some((event) => (
          event.type === "worker-started"
          || event.type === "worker-stopped"
        )),
      `${before?.worker_count} -> ${after?.worker_count}`,
    );
    const callbackIds = events
      .filter((event) => event.type === "ephemeral-callback-end")
      .map((event) => event.request_id);
    requirement(
      "telemetry proves exact distinct request IDs",
      callbackIds.length === 2
        && callbackIds.every(Number.isInteger)
        && new Set(callbackIds).size === 2
        && callbackIds[0] < callbackIds[1],
      callbackIds.join(", "),
    );
    requirement(
      "chat lease is released before and after the scenario",
      before?.chat_lease_count === 0 && after?.chat_lease_count === 0,
      `${before?.chat_lease_count} -> ${after?.chat_lease_count}`,
    );
    const acquiredLeases = events.filter(
      (event) => event.type === "chat-lease-acquired",
    );
    const releasedLeases = events.filter(
      (event) => event.type === "chat-lease-released",
    );
    requirement(
      "telemetry proves two token-owned lease cycles",
      acquiredLeases.length === 2
        && releasedLeases.length === 2
        && releasedLeases.every((event) => event.lease_count === 0),
      `${acquiredLeases.length}/${releasedLeases.length}`,
    );
    const completeLifecycle = injections.length === 2
      && injections.every((injection) => {
        const beforeEvent = (type, predicate = () => true) => (
          [...events].reverse().find((event) => (
            event.sequence < injection.sequence
            && event.type === type
            && predicate(event)
          ))
        );
        const afterEvent = (
          sequence,
          type,
          predicate = () => true,
        ) => events.find((event) => (
          event.sequence > sequence
          && event.type === type
          && predicate(event)
        ));
        const lifecycleLock = beforeEvent(
          "lock-acquired",
          (event) => event.key === "__lifecycle__",
        );
        const routeLock = beforeEvent(
          "lock-acquired",
          (event) => event.key === injection.base_composition_hash,
        );
        const transientActivation = afterEvent(
          injection.sequence,
          "route-activated",
          (event) => event.active_composition_hash
            === injection.active_composition_hash,
        );
        const callbackStart = transientActivation && afterEvent(
          transientActivation.sequence,
          "ephemeral-callback-start",
          (event) => event.active_composition_hash
            === injection.active_composition_hash,
        );
        const callbackEnd = callbackStart && afterEvent(
          callbackStart.sequence,
          "ephemeral-callback-end",
          (event) => event.active_composition_hash
            === injection.active_composition_hash,
        );
        const leaseApplied = callbackStart && callbackEnd && events.find(
          (event) => (
            event.sequence > callbackStart.sequence
            && event.sequence < callbackEnd.sequence
            && event.type === "chat-lease-applied"
          ),
        );
        const cleaned = callbackEnd && afterEvent(
          callbackEnd.sequence,
          "ephemeral-cleaned",
          (event) => event.active_composition_hash
            === injection.active_composition_hash,
        );
        const restored = cleaned && afterEvent(
          cleaned.sequence,
          "route-activated",
          (event) => event.active_composition_hash
            === injection.base_composition_hash,
        );
        const routeReleased = restored && afterEvent(
          restored.sequence,
          "lock-released",
          (event) => event.key === injection.base_composition_hash,
        );
        const lifecycleReleased = routeReleased && afterEvent(
          routeReleased.sequence,
          "lock-released",
          (event) => event.key === "__lifecycle__",
        );
        const leaseReleased = lifecycleReleased && afterEvent(
          lifecycleReleased.sequence,
          "chat-lease-released",
        );
        return Boolean(
          lifecycleLock
          && routeLock
          && lifecycleLock.sequence < routeLock.sequence
          && routeLock.sequence < injection.sequence
          && transientActivation
          && callbackStart
          && leaseApplied
          && callbackEnd
          && Number.isInteger(callbackEnd.request_id)
          && cleaned
          && restored
          && routeReleased
          && lifecycleReleased
          && leaseReleased
        );
      });
    requirement(
      "telemetry proves complete lock-to-cleanup ordering",
      completeLifecycle,
    );
    requirement(
      "telemetry matches current cache counts",
      after?.object_count === readdirSync(
        path.join(betaHome, "routing", "objects"),
      ).length
        && after?.egg_count === readdirSync(
          path.join(betaHome, "routing", "eggs"),
        ).length,
    );
  }
  if (report.scenario === "stack-churn") {
    const before = report.route_telemetry?.before;
    const after = report.route_telemetry?.after;
    const events = (after?.events || []).filter(
      (event) => event.sequence > Number(before?.sequence || 0),
    );
    const created = events.filter((event) => event.type === "stack-created");
    const removed = events.filter((event) => event.type === "stack-removed");
    const installed = events.filter(
      (event) => event.type === "stack-agent-installed",
    );
    const agentRemoved = events.filter(
      (event) => event.type === "stack-agent-removed",
    );
    const workerStarted = events.filter(
      (event) => event.type === "worker-started",
    );
    const workerStopped = events.filter(
      (event) => event.type === "worker-stopped",
    );
    const routeProofs = events.filter(
      (event) => event.type === "route-callback-end",
    );
    requirement(
      "persistent stack proof completed",
      routeProofs.length >= 1
        && routeProofs.some((event) => (
          Number.isInteger(event.request_id)
          && String(event.response_preview || "").includes("STACK_CHURN_READY")
          && (
            String(event.agent_logs_preview || "")
              .match(/STACKCHURNPROOF/gi)?.length === 1
          )
        )),
    );
    const proofFingerprint = routeProofs.find((event) => (
      String(event.response_preview || "").includes("STACK_CHURN_READY")
    ))?.composition_fingerprint;
    const currentProofFingerprint = compositionFingerprint(proofFingerprint);
    requirement(
      "proof composition fingerprint matches routed agent bytes",
      Boolean(
        currentProofFingerprint
        && currentProofFingerprint.source_hash === proofFingerprint?.source_hash
        && currentProofFingerprint.files.includes("stack_churn_agent.py")
      ),
      currentProofFingerprint?.source_hash || "missing",
    );
    const beforeComposition = before?.active_composition_fingerprint;
    const afterComposition = after?.active_composition_fingerprint;
    requirement(
      "default composition bytes return to baseline",
      beforeComposition?.source_hash === afterComposition?.source_hash
        && compositionFingerprint(afterComposition)?.source_hash
          === afterComposition?.source_hash,
      `${beforeComposition?.source_hash || "missing"} -> ${
        afterComposition?.source_hash || "missing"
      }`,
    );
    requirement(
      "stack tree returned to exact baseline",
      JSON.stringify(before?.stack_tree) === JSON.stringify(after?.stack_tree)
        && before?.stack_count === after?.stack_count,
      `${before?.stack_count} -> ${after?.stack_count}`,
    );
    requirement(
      "telemetry proves two temporary stacks were removed",
      created.length === 2
        && removed.length === 2
        && new Set(created.map((event) => event.stack_rappid)).size === 2
        && created.every((event) => removed.some(
          (candidate) => candidate.stack_rappid === event.stack_rappid,
        )),
      `${created.length}/${removed.length}`,
    );
    requirement(
      "telemetry proves persistent agent install and removal",
      installed.length === 1
        && agentRemoved.length === 1
        && installed[0].filename === "stack_churn_agent.py"
        && agentRemoved[0].filename === installed[0].filename
        && agentRemoved[0].stack_rappid === installed[0].stack_rappid,
    );
    requirement(
      "worker churn is balanced and returns to one worker",
      workerStarted.length > 0
        && workerStarted.length === workerStopped.length
        && before?.worker_count === 1
        && after?.worker_count === 1,
      `${workerStarted.length}/${workerStopped.length}`,
    );
    requirement(
      "stack role source is absent from final Explorer",
      !String(report.explorer || "").includes("stack_churn_agent.py"),
    );
  }
  if (report.scenario === "control-handoff") {
    const turns = report.direct_turns || [];
    const markers = [
      "DIRECT_BRAINSTEM_READY_1",
      "DIRECT_BRAINSTEM_READY_2",
    ];
    const requestIds = turns.map((turn) => turn.request_id);
    requirement(
      "two exact direct Brainstem turns completed",
      turns.length === 2
        && turns.every((turn, index) => (
          String(turn.response || "").includes(markers[index])
        )),
    );
    requirement(
      "direct request IDs are distinct and ordered",
      requestIds.length === 2
        && requestIds.every(Number.isInteger)
        && requestIds[0] < requestIds[1],
      requestIds.join(", "),
    );
    const transcript = String(report.brainstem || "");
    const firstMarker = transcript.indexOf(markers[0]);
    const secondMarker = transcript.indexOf(markers[1]);
    const surgeonMarker = transcript.indexOf("LEARNED_AND_TAUGHT:RAPP_READY");
    requirement(
      "visible transcript preserves direct-to-Surgeon order",
      firstMarker >= 0
        && firstMarker < secondMarker
        && secondMarker < surgeonMarker,
      `${firstMarker}, ${secondMarker}, ${surgeonMarker}`,
    );
    const before = report.route_telemetry?.before;
    const after = report.route_telemetry?.after;
    const events = (after?.events || []).filter(
      (event) => event.sequence > Number(before?.sequence || 0),
    );
    const surgeonRequestIds = events
      .filter((event) => event.type === "ephemeral-callback-end")
      .map((event) => event.request_id)
      .filter(Number.isInteger);
    requirement(
      "Brain Surgeon request follows both direct turns",
      surgeonRequestIds.length >= 1
        && surgeonRequestIds.every((requestId) => requestId > requestIds[1]),
      surgeonRequestIds.join(", "),
    );
    requirement(
      "control handoff keeps one mounted iframe and worker",
      before?.navigation_count === after?.navigation_count
        && before?.worker_count === 1
        && after?.worker_count === 1,
      `navigation ${before?.navigation_count} -> ${after?.navigation_count}; `
        + `workers ${before?.worker_count} -> ${after?.worker_count}`,
    );
    requirement(
      "control handoff releases the chat lease",
      before?.chat_lease_count === 0 && after?.chat_lease_count === 0,
      `${before?.chat_lease_count} -> ${after?.chat_lease_count}`,
    );
  }
  requirement(
    "ephemeral source is absent from final Explorer",
    !String(report.explorer || "").includes("five_minute_walkthrough_agent.py"),
  );
  requirement(
    "stack tree has a named selected stack",
    /default · selected/.test(String(report.explorer || ""))
      && !/undefined · selected/.test(String(report.explorer || "")),
  );
  requirement(
    "update check completed without an error state",
    /UPDATE_STATUS=/.test(String(report.response || ""))
      && !/could not check for updates/i.test(String(report.response || "")),
  );
  const gallery = existsSync(galleryPath)
    ? readFileSync(galleryPath, "utf8")
    : "";
  requirement(
    "walkthrough gallery includes latest run",
    gallery.includes(report.run_id),
    galleryPath,
  );
  const temporaryRecordings = existsSync(path.join(betaHome, "recordings"))
    ? readdirSync(path.join(betaHome, "recordings"))
      .filter((filename) => filename.includes(".tmp"))
    : [];
  requirement(
    "no temporary recordings remain",
    temporaryRecordings.length === 0,
    temporaryRecordings.join(", "),
  );

  let metadata = null;
  try {
    metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  } catch {}
  requirement(
    "live UI bridge is running",
    Number.isInteger(metadata?.pid) && processIsAlive(metadata.pid),
    metadata?.pid ? `pid ${metadata.pid}` : "missing metadata",
  );
  const currentSource = betaSourceFingerprint();
  requirement(
    "evidence matches current beta source",
    report.provenance?.source_hash === currentSource.source_hash,
    `${report.provenance?.source_hash || "missing"} vs ${currentSource.source_hash}`,
  );
  requirement(
    "running app startup fingerprint matches current beta source",
    metadata?.runtimeFingerprint?.source_hash === currentSource.source_hash,
    `${metadata?.runtimeFingerprint?.source_hash || "missing"} vs ${
      currentSource.source_hash
    }`,
  );
  requirement(
    "report is bound to the app startup fingerprint",
    Boolean(report.provenance?.runtime_fingerprint?.source_hash)
      && report.provenance?.runtime_fingerprint?.source_hash
      === metadata?.runtimeFingerprint?.source_hash,
    report.provenance?.runtime_fingerprint?.source_hash || "missing",
  );
  const brainstemRuntime = metadata?.brainstemRuntimeFingerprint?.root
    ? runtimeDirectoryFingerprint(metadata.brainstemRuntimeFingerprint.root)
    : null;
  requirement(
    "executed Brainstem runtime matches its startup fingerprint",
    Boolean(brainstemRuntime?.source_hash)
      && brainstemRuntime.source_hash
        === metadata?.brainstemRuntimeFingerprint?.source_hash,
    `${brainstemRuntime?.source_hash || "missing"} vs ${
      metadata?.brainstemRuntimeFingerprint?.source_hash || "missing"
    }`,
  );
  requirement(
    "report binds Brainstem runtime before and after execution",
    report.provenance?.brainstem_runtime_startup?.source_hash
      === metadata?.brainstemRuntimeFingerprint?.source_hash
      && report.provenance?.brainstem_runtime_after?.source_hash
        === metadata?.brainstemRuntimeFingerprint?.source_hash,
    report.provenance?.brainstem_runtime_after?.source_hash || "missing",
  );
  requirement(
    "evidence matches current Git commit",
    report.provenance?.git_head === currentSource.git_head,
    report.provenance?.git_head || "missing",
  );
  requirement(
    "evidence came from the live app instance",
    report.provenance?.app_pid === metadata?.pid
      && report.provenance?.app_started_at === metadata?.startedAt,
    `${report.provenance?.app_pid || "missing"} vs ${metadata?.pid || "missing"}`,
  );
  const evidenceAgeMs = Date.now() - Date.parse(
    report.provenance?.generated_at || "",
  );
  requirement(
    "evidence is fresh",
    Number.isFinite(evidenceAgeMs)
      && evidenceAgeMs >= 0
      && evidenceAgeMs <= 6 * 60 * 60 * 1000,
    Number.isFinite(evidenceAgeMs)
      ? `${Math.round(evidenceAgeMs / 60000)} minutes`
      : "missing timestamp",
  );
  if (!allowUncertified) {
    const validation = report.validation;
    requirement(
      "validation certification is bound to this run",
      validation?.run_id === report.run_id
        && validation?.source_hash === currentSource.source_hash,
      validation?.run_id || "missing",
    );
    const requiredCommands = new Set([
      "syntax",
      "tests",
      "package-gate",
      "walkthrough-gate",
    ]);
    const commands = validation?.commands || [];
    requirement(
      "all validation commands succeeded",
      commands.length === requiredCommands.size
        && commands.every((command) => (
          requiredCommands.has(command.name)
          && command.exit_status === 0
        )),
      commands.map((command) => (
        `${command.name}:${command.exit_status}`
      )).join(", "),
    );
    for (const command of commands) {
      const actual = artifactDescriptor(command.output?.path);
      requirement(
        `validation log hash: ${command.name}`,
        Boolean(actual && actual.sha256 === command.output?.sha256),
        actual?.sha256 || "missing",
      );
    }
  }

  const kernel = kernelIsUnchanged();
  requirement("Grail kernel has no beta diff", kernel.pass, kernel.detail);
  const packageGate = spawnSync(
    process.execPath,
    [path.join(import.meta.dirname, "package-gate.mjs")],
    { encoding: "utf8", windowsHide: true },
  );
  requirement(
    "packaged macOS beta passes release gate",
    packageGate.status === 0,
    String(packageGate.stdout || packageGate.stderr || "").trim(),
  );

  const failures = results.filter((result) => !result.pass);
  process.stdout.write(`\n${"=".repeat(60)}\n`);
  process.stdout.write(
    failures.length
      ? `NOT PERFECT — ${failures.length} of ${results.length} failing\n`
      : `PERFECT — ${results.length}/${results.length} pass\n`,
  );
  process.stdout.write(`${"=".repeat(60)}\n`);
  process.exit(failures.length ? 1 : 0);
}

main();
