import assert from "node:assert/strict";
import {
  mkdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { normalizeVolatile, stableStringify } from "./model-replay.mjs";

function maskTraceValue(value, roots) {
  const normalized = normalizeVolatile(value, { roots });
  function visit(current) {
    if (typeof current === "string") {
      return current
        .replace(
          /\bhttps?:\/\/(?:127\.0\.0\.1|localhost):\d+\b/g,
          "http://127.0.0.1:<PORT>",
        )
        .replace(
          /(\bport["']?\s*[:=]\s*)\d{2,5}\b/gi,
          "$1<PORT>",
        );
    }
    if (Array.isArray(current)) return current.map(visit);
    if (!current || typeof current !== "object") return current;
    return Object.fromEntries(
      Object.entries(current).map(([key, child]) => [
        key,
        /^(?:port|pid)$/i.test(key) && Number.isInteger(child)
          ? `<${key.toUpperCase()}>`
          : visit(child),
      ]),
    );
  }
  return visit(normalized);
}

function atomicWrite(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.tmp`;
  writeFileSync(temporary, value, { mode: 0o600 });
  renameSync(temporary, filePath);
}

export class DriveTrace {
  constructor({ filePath, roots = [] } = {}) {
    this.filePath = filePath;
    this.roots = roots;
    this.events = [];
  }

  record(event) {
    this.events.push(maskTraceValue(event, this.roots));
    this.events.sort((left, right) => left.sequence - right.sequence);
    atomicWrite(this.filePath, this.text());
  }

  text() {
    return this.events.map((event) => stableStringify(event)).join("\n")
      + (this.events.length ? "\n" : "");
  }
}

/**
 * @typedef {{
 *   action: string,
 *   selector?: string,
 *   targetText?: string,
 *   text?: string,
 *   value?: string,
 *   timeoutMs?: number,
 * }} DriveStep
 */

// Frame states a retry can outwait: the frame is being replaced, or it exists
// but has not been laid out yet (zero-size composer on a slow runner).
const TRANSIENT_FRAME_STATE = /not loaded yet|navigated before the command|was destroyed before|was detached before|not actionable: not visible/;

export class FrontierDriver {
  constructor({
    host,
    port,
    token,
    trace,
    timeoutMs = 180_000,
  }) {
    this.url = `http://${host}:${port}/v1/command`;
    this.token = token;
    this.trace = trace;
    this.timeoutMs = timeoutMs;
    this.sequence = 0;
  }

  async command(command, {
    trace = true,
    transportTimeoutMs = null,
  } = {}) {
    const sequence = trace ? ++this.sequence : null;
    try {
      const response = await fetch(this.url, {
        body: JSON.stringify(command),
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
        },
        method: "POST",
        signal: AbortSignal.timeout(
          transportTimeoutMs === null
            ? Math.max(this.timeoutMs, Number(command.timeoutMs) || 0)
            : Math.max(100, Number(transportTimeoutMs) || 0),
        ),
      });
      const payload = await response.json();
      if (!response.ok || !payload?.ok) {
        throw new Error(
          payload?.error || `UI driver returned HTTP ${response.status}.`,
        );
      }
      if (trace) {
        this.trace.record({
          command,
          result: payload.result,
          sequence,
        });
      }
      return payload.result;
    } catch (error) {
      if (trace) {
        this.trace.record({
          command,
          error: String(error.message || error),
          sequence,
        });
      }
      throw error;
    }
  }

  /**
   * @param {DriveStep[]} steps
   * @param {{target?: "shell", twin?: string}} options
   */
  async run(steps, options = {}) {
    // A person waits for the page; so does the harness. The Brainstem frame
    // is swapped on route changes (control words, recomposition) and is laid out
    // late on slow runners, so transient frame states are retried until the
    // command budget is spent — anything else fails immediately.
    const { retryMs = 30_000, trace = true, ...commandOptions } = options;
    const deadline = Date.now() + Math.max(0, Number(retryMs) || 0);
    let attempt = 0;
    for (;;) {
      attempt += 1;
      try {
        const result = await this.command({
          action: "run",
          steps,
          ...commandOptions,
        }, { trace });
        return result.results;
      } catch (error) {
        const message = String(error?.message || error);
        const transient = TRANSIENT_FRAME_STATE.test(message);
        if (!transient || Date.now() >= deadline) {
          if (transient && attempt > 1) {
            error.message = `${message} (after ${attempt} attempts over ${retryMs} ms)`;
          }
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    }
  }

  inspect(options = {}) {
    return this.command({
      action: "inspect",
      ...options,
    });
  }

  routeTelemetry(options = {}) {
    return this.command(
      { action: "route_telemetry" },
      options,
    );
  }

  async expect({
    selector,
    state = "visible",
    target,
    text,
    timeoutMs = 15_000,
    trace = true,
    twin,
  } = {}) {
    if (!selector && text === undefined) {
      throw new Error("driver.expect requires selector or text.");
    }
    if (state !== "visible") {
      throw new Error(`driver.expect does not support state ${state}.`);
    }
    const sequence = trace ? ++this.sequence : null;
    const expectation = {
      action: "expect",
      selector,
      state,
      target,
      text: text instanceof RegExp ? text.toString() : text,
      timeoutMs,
      twin,
    };
    const deadline = Date.now() + timeoutMs;
    let lastResult = null;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        if (selector) {
          lastResult = await this.command({
            action: "read",
            selector,
            target,
            twin,
          }, {
            trace: false,
            transportTimeoutMs: Math.min(2_000, deadline - Date.now()),
          });
          const actual = String(lastResult.text || "");
          const matches = text === undefined
            || (text instanceof RegExp
              ? text.test(actual)
              : actual.includes(String(text)));
          if (matches) {
            if (trace) {
              this.trace.record({
                command: expectation,
                result: lastResult,
                sequence,
              });
            }
            return lastResult;
          }
        } else {
          lastResult = await this.command({
            action: "wait",
            target,
            text: String(text),
            timeoutMs: Math.min(1_000, Math.max(100, deadline - Date.now())),
            twin,
          }, {
            trace: false,
            transportTimeoutMs: Math.min(2_000, deadline - Date.now()),
          });
          if (trace) {
            this.trace.record({
              command: expectation,
              result: lastResult,
              sequence,
            });
          }
          return lastResult;
        }
      } catch (error) {
        lastError = error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const message = `Expected ${selector || JSON.stringify(text)} to match before timeout; `
      + `last result=${JSON.stringify(lastResult)}, `
      + `last error=${String(lastError?.message || lastError || "none")}`;
    if (trace) {
      this.trace.record({
        command: expectation,
        error: message,
        sequence,
      });
    }
    assert.fail(message);
  }
}

export function createDriver(metadata, options = {}) {
  return new FrontierDriver({ ...metadata, ...options });
}
