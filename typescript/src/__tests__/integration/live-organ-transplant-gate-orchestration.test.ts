import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

interface ProcessObservation {
  childPid: number | null;
  status: number | null;
  elapsedMs: number;
  spawnObserved: boolean;
  exitObserved: boolean;
  closeObserved: boolean;
  timedOut: boolean;
  forcedSettled: boolean;
  groupTerminationAttempted: boolean;
  groupTerminationCompleted: boolean;
  pipesDestroyed: boolean;
  runtimePid: number | null;
  runtimePidObservedWhileAlive: boolean;
  runtimeAliveAtObservation: boolean;
  runtimePgid: number | null;
  runtimeState: string | null;
  runtimeGroupMatches: boolean;
  error: Error | null;
}

interface GateModule {
  TRANSPLANT_GATE_PHASE_ORDER: string[];
  GatePhaseTracker: new () => {
    enter(phase: string): void;
    complete(): boolean;
  };
  runProcess(
    executable: string,
    args: string[],
    options: {
      cwd: string;
      environment: NodeJS.ProcessEnv;
      timeoutMs: number;
      settleGraceMs?: number;
      hardFallbackMs?: number;
      terminateTree?: () => Promise<never>;
      runtimePidHandoffPath?: string;
      runtimePidNonce?: string;
    },
  ): Promise<ProcessObservation>;
  finalizeGateRunRoot(runRoot: string, failedNames: string[]): string | null;
  processStateIsLive(state: unknown): boolean;
}

const GATE_PATH = fileURLToPath(
  new URL("../../../../tools/live-organ-transplant-gate.mjs", import.meta.url),
);
let gate: GateModule;

beforeAll(async () => {
  gate = (await import(
    `${pathToFileURL(GATE_PATH).href}?orchestration-test=1`
  )) as GateModule;
});

describe("live organ transplant gate orchestration", () => {
  it("pins probe before success before missing-Python in the executed source", () => {
    expect(gate.TRANSPLANT_GATE_PHASE_ORDER).toEqual([
      "independent-probe",
      "success-command",
      "missing-python-command",
    ]);
    const source = readFileSync(GATE_PATH, "utf8");
    const positions = gate.TRANSPLANT_GATE_PHASE_ORDER.map((phase) => {
      const marker = `phaseTracker.enter("${phase}")`;
      expect(source.split(marker)).toHaveLength(2);
      return source.indexOf(marker);
    });
    expect(positions[0]).toBeLessThan(positions[1]!);
    expect(positions[1]).toBeLessThan(positions[2]!);
  });

  it("rejects any orchestration that enters demo before the independent probe", () => {
    const tracker = new gate.GatePhaseTracker();
    expect(() => tracker.enter("success-command")).toThrow(
      /expected independent-probe/,
    );
    tracker.enter("independent-probe");
    tracker.enter("success-command");
    tracker.enter("missing-python-command");
    expect(tracker.complete()).toBe(true);
  });

  it("fails unsupported platforms before spawn and contains no native Windows runner", () => {
    const source = readFileSync(GATE_PATH, "utf8");
    expect(source).not.toContain("taskkill");
    expect(source).not.toContain('process.platform === "win32"');
    expect(source).not.toContain("npm.cmd");
    expect(source.indexOf("if (!platformSupported) return;")).toBeGreaterThan(
      0,
    );
    expect(source.indexOf("if (!platformSupported) return;")).toBeLessThan(
      source.indexOf("const buildRun = await runProcess"),
    );
  });

  it("settles inherited pipes and the known process group after direct-child exit", async () => {
    const childSource = [
      "const { spawn } = require('node:child_process');",
      "spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],",
      "  { stdio: ['ignore', process.stdout, process.stderr] });",
      "process.exit(0);",
    ].join("\n");
    const observation = await gate.runProcess(
      process.execPath,
      ["-e", childSource],
      {
        cwd: process.cwd(),
        environment: {},
        timeoutMs: 3_000,
      },
    );

    expect(observation).toMatchObject({
      status: 0,
      spawnObserved: true,
      exitObserved: true,
      timedOut: false,
      groupTerminationAttempted: true,
      groupTerminationCompleted: true,
      pipesDestroyed: true,
    });
    expect(observation.closeObserved || observation.forcedSettled).toBe(true);
    expect(observation.elapsedMs).toBeLessThan(3_000);
  });

  it("hard-settles when tree termination never resolves", async () => {
    const started = performance.now();
    const observation = await gate.runProcess(
      process.execPath,
      ["-e", "process.exit(0)"],
      {
        cwd: path.dirname(GATE_PATH),
        environment: {},
        timeoutMs: 50,
        hardFallbackMs: 50,
        terminateTree: () => new Promise<never>(() => {}),
      },
    );

    expect(observation.spawnObserved).toBe(true);
    expect(observation.exitObserved).toBe(true);
    expect(observation.forcedSettled).toBe(true);
    expect(observation.groupTerminationAttempted).toBe(true);
    expect(observation.pipesDestroyed).toBe(true);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("observes the runtime PID handoff alive in the detached process group", async () => {
    const scratchBase = path.resolve(
      path.dirname(GATE_PATH),
      "..",
      ".test-scratch",
      "runtime-observation",
    );
    mkdirSync(scratchBase, { recursive: true, mode: 0o700 });
    const handoffPath = path.join(scratchBase, "runtime-pid.json");
    const nonce = "runtime-observation-nonce";
    try {
      const source = [
        "const fs = require('node:fs');",
        `fs.writeFileSync(${JSON.stringify(handoffPath)},`,
        `  JSON.stringify({schema:'openrappter-runtime-pid/1.0',nonce:${JSON.stringify(nonce)},pid:process.pid}),`,
        "  {flag:'wx',mode:0o600});",
        "setTimeout(() => process.exit(0), 200);",
      ].join("\n");
      const observation = await gate.runProcess(
        process.execPath,
        ["-e", source],
        {
          cwd: process.cwd(),
          environment: {},
          timeoutMs: 2_000,
          runtimePidHandoffPath: handoffPath,
          runtimePidNonce: nonce,
        },
      );
      expect(observation.runtimePid).toBe(observation.childPid);
      expect(observation.runtimePidObservedWhileAlive).toBe(true);
      expect(observation.runtimeAliveAtObservation).toBe(true);
      expect(observation.runtimePgid).toBe(observation.childPid);
      expect(gate.processStateIsLive(observation.runtimeState)).toBe(true);
      expect(observation.runtimeGroupMatches).toBe(true);
    } finally {
      rmSync(scratchBase, { recursive: true, force: true });
      try {
        rmdirSync(path.dirname(scratchBase));
      } catch {
        // Other tests may still own siblings in the shared scratch parent.
      }
    }
  });

  it("treats zombie and dead process states as not live", () => {
    expect(gate.processStateIsLive("S")).toBe(true);
    expect(gate.processStateIsLive("R+")).toBe(true);
    expect(gate.processStateIsLive("Z")).toBe(false);
    expect(gate.processStateIsLive("Z+")).toBe(false);
    expect(gate.processStateIsLive("X")).toBe(false);
    expect(gate.processStateIsLive(null)).toBe(false);
  });

  it("removes successful run roots and preserves marked failure evidence", () => {
    const scratchBase = path.resolve(
      path.dirname(GATE_PATH),
      "..",
      ".test-scratch",
      "gate-orchestration",
    );
    mkdirSync(scratchBase, { recursive: true, mode: 0o700 });
    try {
      const successRoot = mkdtempSync(path.join(scratchBase, "success-"));
      writeFileSync(path.join(successRoot, ".gate-active"), "active", {
        mode: 0o600,
      });
      expect(gate.finalizeGateRunRoot(successRoot, [])).toBeNull();
      expect(existsSync(successRoot)).toBe(false);

      const failureRoot = mkdtempSync(path.join(scratchBase, "failure-"));
      writeFileSync(path.join(failureRoot, ".gate-active"), "active", {
        mode: 0o600,
      });
      expect(gate.finalizeGateRunRoot(failureRoot, ["causal-trace"])).toBe(
        failureRoot,
      );
      expect(existsSync(path.join(failureRoot, ".gate-failed"))).toBe(true);
    } finally {
      rmSync(scratchBase, { recursive: true, force: true });
      try {
        rmdirSync(path.dirname(scratchBase));
      } catch {
        // Other tests may still own siblings in the shared scratch parent.
      }
    }
  });
});
