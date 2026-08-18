/**
 * A Python single-file agent, usable by the Node daemon.
 *
 * The grail brainstem and the RAR catalog both produce `.py` agents, and Kody's
 * ask was that dropping one on openrappter works "just like the vbrainstem and
 * grail brainstem installer repo allows". The daemon is Node, so the choice was
 * either to make people port an agent before it works, or to bridge. This
 * bridges: each call spawns `python3 runner.py`, which loads the file with the
 * same import shims the brainstem provides and returns JSON.
 *
 * A subprocess per call is the right trade here. Agents are invoked at human
 * speed, one at a time, from a chat turn — and a crashed or hanging agent takes
 * its own process down instead of the daemon.
 */

import { spawn } from 'child_process';
import { existsSync } from 'node:fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { BasicAgent } from './BasicAgent.js';
import type { AgentMetadata } from './types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Where runner.py lives. It sits next to the compiled output as a static asset. */
export function runnerPath(): string {
  const bundled = path.join(HERE, 'python', 'runner.py');
  const marker = `${path.sep}app.asar${path.sep}`;
  if (bundled.includes(marker)) {
    const unpacked = bundled.replace(
      marker,
      `${path.sep}app.asar.unpacked${path.sep}`,
    );
    if (existsSync(unpacked)) return unpacked;
  }
  return bundled;
}

export interface PythonAgentDescriptor {
  name: string;
  description: string;
  parameters: AgentMetadata['parameters'];
}

interface RunnerOk { status: 'ok'; }
interface RunnerErr { status: 'error'; error: string; }

/** Default ceiling for one agent call. Long enough for real work, short enough to not wedge a chat turn. */
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Conformance R2/R3: every agent declares a manifest so a strain can govern it
 * without reading the source. This file had none — which mattered more here
 * than anywhere else in the repo, because this is the agent that runs other
 * people's code.
 */
export const __manifest__ = {
  schema: 'rapp-agent/1.0',
  name: '@openrappter/python',
  version: '1.0.0',
  display_name: 'Python',
  description:
    'Runs a single-file Python agent in a subprocess, so a Python cartridge is '
    + 'callable from the TypeScript runtime without being rewritten.',
  author: 'Kody Wildfeuer',
  ring: 'ga',
  // The two most consequential capabilities in the contract, and both are
  // exactly what this agent is for:
  //   process-exec  — `spawn('python3', [runner.py, ...])` on every call
  //   dynamic-code  — the runner loads an arbitrary .py file by path and calls
  //                   into it, so the code executed is not this file's code
  // A strain that forbids either MUST withhold this agent. Undeclared, it would
  // have been the quietest way in the repo to run arbitrary code.
  capabilities: [
    'process-exec',
    'dynamic-code',
  ],
  tags: [
    'openrappter',
    'python',
    'bridge',
  ],
  category: 'meta',
  quality_tier: 'official',
  requires_env: [],
} as const;

function runPython(
  args: string[],
  stdin: string | null,
  timeoutMs: number,
  python: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(python, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve({ code: 124, stdout, stderr: stderr + `\ntimed out after ${timeoutMs}ms` });
    }, timeoutMs);

    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: String(err) });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? 0, stdout, stderr });
    });

    if (stdin !== null) child.stdin.write(stdin);
    child.stdin.end();
  });
}

/** Ask a `.py` file what agents it defines. Rejects anything that is not an agent. */
export async function introspectPythonAgents(
  file: string,
  opts: { python?: string; timeoutMs?: number } = {},
): Promise<{ ok: true; agents: PythonAgentDescriptor[] } | { ok: false; error: string }> {
  const python = opts.python ?? process.env.OPENRAPPTER_PYTHON ?? 'python3';
  const { stdout, stderr } = await runPython(
    [runnerPath(), 'introspect', file],
    null,
    opts.timeoutMs ?? 20_000,
    python,
  );

  let parsed: (RunnerOk & { agents?: PythonAgentDescriptor[] }) | RunnerErr;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    // No parseable payload means the runner itself never got to speak — say what
    // actually happened rather than "invalid agent", which would be a guess.
    const detail = stderr.trim().split('\n').slice(-3).join(' ').slice(0, 300);
    return { ok: false, error: detail || 'python produced no output' };
  }

  if (parsed.status === 'error') return { ok: false, error: (parsed as RunnerErr).error };
  const agents = (parsed as { agents?: PythonAgentDescriptor[] }).agents ?? [];
  if (agents.length === 0) return { ok: false, error: 'no agent classes found in file' };
  return { ok: true, agents };
}

/**
 * A Python agent presented to the assistant as an ordinary agent.
 *
 * From the tool-calling loop's point of view this is indistinguishable from a
 * native TypeScript agent — same metadata shape, same `perform` contract — which
 * is what lets a dropped file be usable in the very next message.
 */
export class PythonAgent extends BasicAgent {
  /**
   * Not a standalone agent.
   *
   * This class is a wrapper the registry constructs once per descriptor found
   * in a user's `.py` file, so it needs `(file, descriptor)` and cannot be
   * instantiated bare. Built-in discovery instantiates every exported subclass
   * of `BasicAgent` with no arguments, which meant it reached this constructor,
   * threw on `descriptor.name`, and recorded `PythonAgent.js` as a failed agent
   * file on every single run. The marker is what tells discovery to skip it.
   */
  static readonly isTemplate = true;

  private readonly file: string;
  private readonly agentName: string;
  private readonly python: string;
  private readonly timeoutMs: number;

  constructor(
    file: string,
    descriptor: PythonAgentDescriptor,
    opts: { python?: string; timeoutMs?: number } = {},
  ) {
    const metadata: AgentMetadata = {
      name: descriptor.name,
      description: descriptor.description || `Python agent from ${path.basename(file)}`,
      parameters: descriptor.parameters ?? { type: 'object', properties: {}, required: [] },
    };
    super(descriptor.name, metadata);
    this.file = file;
    this.agentName = descriptor.name;
    this.python = opts.python ?? process.env.OPENRAPPTER_PYTHON ?? 'python3';
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** The file this agent came from, so the anatomy page can point at it. */
  get sourceFile(): string { return this.file; }

  async perform(kwargs: Record<string, unknown>): Promise<string> {
    const { stdout, stderr, code } = await runPython(
      [runnerPath(), 'run', this.file, this.agentName],
      JSON.stringify(kwargs ?? {}),
      this.timeoutMs,
      this.python,
    );

    let parsed: { status: string; result?: string; error?: string };
    try {
      parsed = JSON.parse(stdout.trim());
    } catch {
      const detail = stderr.trim().split('\n').slice(-3).join(' ').slice(0, 300);
      return JSON.stringify({
        status: 'error',
        error: `${this.agentName} did not return a result (exit ${code}): ${detail || 'no output'}`,
      });
    }

    if (parsed.status === 'error') {
      return JSON.stringify({ status: 'error', error: parsed.error ?? 'agent failed' });
    }
    return parsed.result ?? '';
  }
}
