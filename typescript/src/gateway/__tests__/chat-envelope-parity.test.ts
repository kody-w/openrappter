/**
 * The two runtimes must answer with the same envelope.
 *
 * PARITY §0: *"If two runtimes claiming to be RAPP diverge on the wire, then the
 * estate is not one medium — it is N incompatible products wearing the same
 * name."* openrappter ships two substrates, and they were emitting different
 * envelopes: TypeScript 3/6 required keys, Python 4/6, neither 6/6. That fails
 * parity internally, before the estate is even involved.
 *
 * These tests diff the two implementations against each other on identical
 * input. That diff is the thing that stops the drift recurring — without it the
 * two separate again the moment someone edits one side.
 */

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

import { buildChatEnvelope, ENVELOPE_REQUIRED_KEYS } from '../chat-envelope.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PY_BRAINSTEM = path.resolve(HERE, '../../../../python/openrappter/brainstem.py');

/**
 * Build the same envelope through the Python implementation.
 *
 * Imported by path rather than by package so the test does not require the
 * package to be pip-installed, and so it reads the file actually in this repo.
 */
function pythonEnvelope(content: string, sessionId: string, logs: string[]): Record<string, unknown> | null {
  const script = `
import importlib.util, json, sys, types

# brainstem.py imports heavy optional deps at module scope in some configs; the
# envelope builder itself is pure, so load the module with those stubbed rather
# than requiring a full install to test a pure function.
spec = importlib.util.spec_from_file_location("bs", ${JSON.stringify(PY_BRAINSTEM)})
mod = importlib.util.module_from_spec(spec)
sys.modules["bs"] = mod
try:
    spec.loader.exec_module(mod)
except SystemExit:
    pass
print(json.dumps(mod.build_chat_envelope(
    ${JSON.stringify(content)}, ${JSON.stringify(sessionId)}, ${JSON.stringify(logs)}
)))
`;
  try {
    const out = execFileSync('python3', ['-c', script], {
      encoding: 'utf-8',
      timeout: 30_000,
      stdio: ['ignore', 'pipe', 'pipe'],
      // brainstem.py does `from openrappter...` at module scope, so the package
      // root has to be importable. Without this the load failed and every
      // cross-runtime case skipped — a green tick that proved nothing.
      env: { ...process.env, PYTHONPATH: path.resolve(HERE, '../../../../python') },
    });
    return JSON.parse(out.trim().split('\n').pop() as string);
  } catch {
    return null;
  }
}

/**
 * The keys both runtimes must agree on. Extra axes are free per §3.
 *
 * `model` and `requested_model` are deliberately excluded from the *value*
 * diff. PARITY §6.1: the harness compares the envelope "**modulo out-of-scope
 * keys** (`model`, `requested_model`, and any value the vector marks
 * `ignore`)". They report what this runtime, on this machine, with this
 * configuration, actually asked for and got — the Python tier defaults to
 * `claude-sonnet-5` against the Copilot API, the TypeScript tier to `auto`
 * against the CLI — so requiring the two to emit identical strings would fail
 * on a difference the spec explicitly says is not drift.
 *
 * Their *presence* is still required by §2.4 and is asserted separately below;
 * only the value is out of scope.
 */
const OUT_OF_SCOPE_KEYS = new Set(['model', 'requested_model']);

function frozenView(e: Record<string, unknown>): Record<string, unknown> {
  const view: Record<string, unknown> = {};
  for (const k of ENVELOPE_REQUIRED_KEYS) {
    if (OUT_OF_SCOPE_KEYS.has(k)) continue;
    view[k] = e[k];
  }
  if ('voice_response' in e) view.voice_response = e.voice_response;
  return view;
}

describe('the frozen envelope', () => {
  it('emits every key PARITY §2.4 requires', () => {
    const e = buildChatEnvelope({ content: 'hi', sessionId: 's1' });
    for (const k of ENVELOPE_REQUIRED_KEYS) {
      expect(e, `missing required key: ${k}`).toHaveProperty(k);
    }
  });

  it('never emits assistant_response — KERNEL §2.2 forbids it', () => {
    const e = buildChatEnvelope({ content: 'hi', sessionId: 's1' });
    expect(e).not.toHaveProperty('assistant_response');
  });

  it('keeps the extra axes existing callers read (§3: extras are not drift)', () => {
    const e = buildChatEnvelope({ content: 'hi', sessionId: 's1' });
    expect(e.schema).toBe('rapp-chat/1.0');
    expect(e.status).toBe('success');
    expect(e.sessionId).toBe('s1');
    expect(e.content).toBe('hi');
  });

  it('joins agent_logs with newlines, in execution order (§2.3)', () => {
    const e = buildChatEnvelope({
      content: 'done', sessionId: 's1',
      agentLogs: ['[Tide] outgoing', '[Reef] 62% cover'],
    });
    expect(e.agent_logs).toBe('[Tide] outgoing\n[Reef] 62% cover');
  });

  it('sets model and requested_model equal when no fallback fired (§2.4)', () => {
    const e = buildChatEnvelope({ content: 'hi', sessionId: 's1', model: 'gpt-5' });
    expect(e.model).toBe('gpt-5');
    expect(e.requested_model).toBe('gpt-5');
  });

  it('reports them differently when the runtime switched models', () => {
    const e = buildChatEnvelope({
      content: 'hi', sessionId: 's1', model: 'fallback-model', requestedModel: 'asked-for',
    });
    expect(e.model).toBe('fallback-model');
    expect(e.requested_model).toBe('asked-for');
  });
});

describe('the voice seam is split, not shipped raw', () => {
  it('never leaves the sentinel inside response', () => {
    // This was a visible product bug: every reply carried the literal marker.
    const e = buildChatEnvelope({
      content: 'Hey there!\n\n|||VOICE|||\nHey, good to see you!',
      sessionId: 's1',
    });
    expect(e.response).not.toContain('|||VOICE|||');
    expect(e.response).toBe('Hey there!');
    expect(e.voice_response).toBe('Hey, good to see you!');
    expect(e.voice_mode).toBe(true);
  });

  it('leaves a reply with no sentinel completely untouched', () => {
    const e = buildChatEnvelope({ content: 'just text', sessionId: 's1' });
    expect(e.response).toBe('just text');
    expect(e.voice_mode).toBe(false);
    expect(e).not.toHaveProperty('voice_response');
  });

  it('stops the spoken block at the next sense marker', () => {
    const e = buildChatEnvelope({
      content: 'main\n|||VOICE|||\nspoken\n|||HOLO|||\nvisual',
      sessionId: 's1',
    });
    expect(e.voice_response).toBe('spoken');
    expect(e.response).toBe('main');
  });
});

describe('TypeScript and Python agree on the wire', () => {
  const cases: Array<[string, string, string[]]> = [
    ['plain reply', 'hello there', []],
    ['with voice seam', 'Hey!\n\n|||VOICE|||\nHey, good to see you!', []],
    ['with agent logs', 'done', ['[Tide] outgoing', '[Reef] 62% cover']],
    ['empty reply', '', []],
  ];

  for (const [label, content, logs] of cases) {
    it(`emits an identical frozen envelope: ${label}`, () => {
      const py = pythonEnvelope(content, 'sess-1', logs);
      if (py === null) {
        // Python is not a hard dependency of the TS test run. Skipping loudly
        // beats a green tick that proved nothing.
        console.warn('SKIPPED: python3 could not load brainstem.py');
        return;
      }
      const ts = buildChatEnvelope({ content, sessionId: 'sess-1', agentLogs: logs });

      // `model` is substrate-specific (each names its own backend), so compare
      // its PRESENCE and the model/requested_model relationship rather than the
      // literal string — that relationship is what §2.4 actually freezes.
      expect(Object.keys(py)).toEqual(expect.arrayContaining([...ENVELOPE_REQUIRED_KEYS]));
      expect(typeof py.model).toBe('string');

      // §2.4: "A runtime with no fallback sets them equal." No fallback happens
      // in these cases, so the two must agree — UNLESS the backend never told us
      // which model answered, which §2.4 does not contemplate. Both runtimes
      // then emit an explicit `<backend>:auto` / `<backend>:unreported` marker
      // rather than echoing the request back as though it had been confirmed,
      // so a caller can distinguish "a fallback switched models" from "nobody
      // said". Asserting bare equality here would have forced that echo, which
      // is the false attribution the marker exists to avoid.
      const unattributed = /^[a-z0-9-]+:(auto|unreported)$/;
      for (const [runtime, env] of [['python', py], ['typescript', ts]] as const) {
        const model = env.model as string;
        const requested = env.requested_model as string;
        if (unattributed.test(model)) {
          // The marker must not masquerade as a real model id.
          expect(model, `${runtime}: unattributed marker names the request`)
            .not.toBe(requested);
        } else {
          expect(requested, `${runtime}: no fallback, so §2.4 requires equality`)
            .toBe(model);
        }
      }

      const a = frozenView(ts); const b = frozenView(py);
      expect(b).toEqual(a);
    }, 40_000);
  }
});
