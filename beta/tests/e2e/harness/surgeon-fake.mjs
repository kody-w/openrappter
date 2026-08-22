import { readFileSync } from "node:fs";

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function loadScript(env) {
  if (env.BRAINSTEM_BETA_SURGEON_SCRIPT_JSON) {
    return JSON.parse(env.BRAINSTEM_BETA_SURGEON_SCRIPT_JSON);
  }
  if (env.BRAINSTEM_BETA_SURGEON_SCRIPT) {
    return JSON.parse(readFileSync(
      env.BRAINSTEM_BETA_SURGEON_SCRIPT,
      "utf8",
    ));
  }
  return {
    sessions: [{
      match: {},
      turns: [{ final: "Fake Rappter Surgeon is ready." }],
    }],
  };
}

function promptMatches(match = {}, prompt) {
  if (typeof match === "string") return prompt === match;
  if (match.prompt !== undefined && prompt !== match.prompt) return false;
  if (
    match.includes !== undefined
    && !prompt.includes(String(match.includes))
  ) {
    return false;
  }
  return true;
}

function normalizeScript(value) {
  const script = value && typeof value === "object" ? value : {};
  const sessions = Array.isArray(script.sessions)
    ? script.sessions
    : Array.isArray(script)
      ? script
      : [];
  if (!sessions.length) {
    throw new Error("The fake Surgeon script must define at least one session.");
  }
  return {
    concurrent: script.mode === "concurrent" || script.concurrent === true,
    concurrency: Math.max(2, Number.parseInt(script.concurrency || "2", 10)),
    sessions: sessions.map((session, index) => {
      const turns = Array.isArray(session.turns) ? session.turns : [];
      if (!turns.some((turn) => Object.hasOwn(turn, "final"))) {
        throw new Error(
          `Fake Surgeon session ${index + 1} must end with a final turn.`,
        );
      }
      return {
        id: session.id || `session-${index + 1}`,
        match: session.match || {},
        turns,
      };
    }),
  };
}

class FakeSession {
  constructor(client, config) {
    this.client = client;
    this.config = config;
    this.listeners = new Set();
    this.disconnected = false;
  }

  on(listener) {
    if (typeof listener !== "function") {
      throw new TypeError("Fake Surgeon session listener must be a function.");
    }
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(type, data = {}) {
    for (const listener of this.listeners) {
      listener({ type, data: clone(data) });
    }
  }

  async sendAndWait(request) {
    if (this.disconnected) {
      throw new Error("Fake Surgeon session is disconnected.");
    }
    const prompt = String(request?.prompt || "");
    return this.client.run(this, prompt);
  }

  async disconnect() {
    this.disconnected = true;
    this.listeners.clear();
  }
}

class ConcurrentBatch {
  constructor(client, size) {
    this.client = client;
    this.size = size;
    this.pending = [];
  }

  enqueue(run) {
    return new Promise((resolve, reject) => {
      this.pending.push({ ...run, resolve, reject });
      if (this.pending.length === this.size) {
        const batch = this.pending.splice(0, this.size);
        queueMicrotask(() => {
          this.client.executeConcurrent(batch).catch((error) => {
            for (const item of batch) item.reject(error);
          });
        });
      }
    });
  }

  rejectPending(error) {
    for (const item of this.pending.splice(0)) item.reject(error);
  }
}

export class SurgeonFakeClient {
  constructor({
    env = process.env,
    script = null,
    workingDirectory = process.cwd(),
  } = {}) {
    this.env = env;
    this.workingDirectory = workingDirectory;
    this.script = normalizeScript(script || loadScript(env));
    this.started = false;
    this.sessions = new Set();
    this.claimedScripts = new Set();
    this.calls = [];
    this.batch = this.script.concurrent
      ? new ConcurrentBatch(this, this.script.concurrency)
      : null;
  }

  async start() {
    this.started = true;
  }

  async getAuthStatus() {
    return {
      isAuthenticated: true,
      login: "frontier-e2e",
    };
  }

  async createSession(config) {
    if (!this.started) throw new Error("Fake Surgeon runtime is not started.");
    const session = new FakeSession(this, config);
    this.sessions.add(session);
    return session;
  }

  claimScript(prompt) {
    const index = this.script.sessions.findIndex((candidate, candidateIndex) => (
      !this.claimedScripts.has(candidateIndex)
      && promptMatches(candidate.match, prompt)
    ));
    if (index < 0) {
      throw new Error(`No fake Surgeon session matches prompt: ${prompt}`);
    }
    this.claimedScripts.add(index);
    return { index, script: this.script.sessions[index] };
  }

  run(session, prompt) {
    const claimed = this.claimScript(prompt);
    const run = { ...claimed, prompt, session };
    return this.batch
      ? this.batch.enqueue(run)
      : this.executeSequential(run);
  }

  toolFor(session, name) {
    const tool = session.config?.tools?.find((candidate) => candidate.name === name);
    if (!tool || typeof tool.handler !== "function") {
      throw new Error(`Fake Surgeon script requested unknown tool: ${name}`);
    }
    return tool;
  }

  async executeTool(run, turn, sequence) {
    const toolCall = turn.tool || turn.tool_call;
    const name = toolCall.name;
    const args = clone(toolCall.arguments || toolCall.args || {});
    const toolCallId = toolCall.id || `fake-tool-${run.index + 1}-${sequence + 1}`;
    const tool = this.toolFor(run.session, name);
    run.session.emit("tool.execution_start", { toolCallId, toolName: name });
    this.calls.push({
      arguments: args,
      prompt: run.prompt,
      scriptId: run.script.id,
      toolCallId,
      toolName: name,
    });
    try {
      const result = await tool.handler(args);
      run.session.emit("tool.execution_complete", {
        success: true,
        toolCallId,
        toolName: name,
      });
      return result;
    } catch (error) {
      run.session.emit("tool.execution_complete", {
        success: false,
        toolCallId,
        toolName: name,
      });
      throw error;
    }
  }

  emitText(run, text) {
    if (text) {
      run.session.emit("assistant.message_delta", {
        deltaContent: String(text),
      });
    }
  }

  async executeSequential(run) {
    let final = "";
    for (let index = 0; index < run.script.turns.length; index += 1) {
      const turn = run.script.turns[index];
      if (turn.tool || turn.tool_call) await this.executeTool(run, turn, index);
      if (Object.hasOwn(turn, "delta")) this.emitText(run, turn.delta);
      if (Object.hasOwn(turn, "final")) final = String(turn.final || "");
    }
    return { data: { content: final } };
  }

  async executeConcurrent(batch) {
    const ordered = [...batch].sort((left, right) => left.index - right.index);
    const finals = new Map();
    const turnCount = Math.max(...ordered.map((run) => run.script.turns.length));
    for (let turnIndex = 0; turnIndex < turnCount; turnIndex += 1) {
      const toolRuns = [];
      for (const run of ordered) {
        const turn = run.script.turns[turnIndex];
        if (!turn) continue;
        if (turn.tool || turn.tool_call) {
          toolRuns.push({
            promise: this.executeTool(run, turn, turnIndex),
            run,
          });
        }
        if (Object.hasOwn(turn, "delta")) this.emitText(run, turn.delta);
        if (Object.hasOwn(turn, "final")) {
          finals.set(run, String(turn.final || ""));
        }
      }
      for (const item of toolRuns) await item.promise;
    }
    for (const run of ordered) {
      run.resolve({ data: { content: finals.get(run) || "" } });
    }
  }

  async stop() {
    this.batch?.rejectPending(
      new Error("Fake Surgeon runtime stopped before its concurrent batch filled."),
    );
    await Promise.allSettled(
      [...this.sessions].map((session) => session.disconnect()),
    );
    this.sessions.clear();
    this.started = false;
  }

  async forceStop() {
    await this.stop();
  }
}

export function createSurgeonFakeClient(options = {}) {
  return new SurgeonFakeClient(options);
}
