#!/usr/bin/env node
/**
 * Drive the TypeScript runtime through one golden parity vector.
 *
 * PARITY §5.2 requires the model to be mocked with a scripted responder,
 * because the model is an out-of-scope axis (§3) and parity governs the
 * runtime's *loop, envelope and ABI handling* — not which model answered.
 * `Assistant.provider.chat()` is this runtime's model-call seam, so that is
 * where the script is injected. Everything downstream of it — the tool loop,
 * the round cap, agent_logs, the envelope builder — is the real code.
 *
 * Reads one vector as JSON on stdin, prints the resulting envelope (or a
 * structured error) as JSON on stdout, so `parity_harness.py` can judge both
 * runtimes with the SAME comparator. Two drivers, one set of expectations —
 * otherwise a difference in the checker could be mistaken for parity.
 *
 *     echo "$(cat parity_vectors/round-cap-3.json)" | node ts_parity_driver.mjs
 */
import { Assistant } from './typescript/dist/agents/Assistant.js';
import { buildChatEnvelope } from './typescript/dist/gateway/chat-envelope.js';
import { parseChatRequest } from './typescript/dist/gateway/chat-request.js';

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

/** The scripted responder. Records outbound messages so the vector can assert on them. */
class ScriptedProvider {
  constructor(script) {
    this.script = script ?? [];
    this.round = 0;
    this.outbound = [];
    this.toolsSeen = [];
  }

  isAvailable() { return true; }

  async chat(messages, options) {
    this.round += 1;
    this.outbound.push(JSON.parse(JSON.stringify(messages)));
    this.toolsSeen.push(options?.tools ?? null);

    for (const step of this.script) {
      if (step.round !== this.round) continue;
      const emit = step.emit ?? {};
      return {
        content: emit.content ?? null,
        tool_calls: emit.tool_calls ?? null,
        finish_reason: emit.finish_reason,
      };
    }
    // Running off the end of the script is a finding, not a crash: the runtime
    // looped more times than the vector allows for.
    return { content: `__UNSCRIPTED_ROUND_${this.round}__`, tool_calls: null };
  }
}

/** Build the vector's declarative agents into objects this runtime can call. */
function buildAgents(fixture) {
  const agents = new Map();
  for (const spec of fixture.agents ?? []) {
    const perform = spec.perform ?? {};
    const agent = {
      name: spec.name,
      metadata: spec.metadata,
      async execute(kwargs) { return agent.perform(kwargs); },
      async perform(kwargs = {}) {
        if (perform.kind === 'raises') {
          throw new Error(perform.message ?? 'error');
        }
        const values = { ...kwargs };
        if (String(perform.returns ?? '').includes('{sum}')) {
          const a = Number(kwargs.a ?? 0);
          const b = Number(kwargs.b ?? 0);
          values.sum = Number.isFinite(a) && Number.isFinite(b) ? a + b : '';
        }
        let out = perform.returns ?? '';
        for (const [key, value] of Object.entries(values)) {
          out = out.split('{' + key + '}').join(String(value));
        }
        // Unfilled placeholders mean the argument was absent; the
        // bad-arguments vector depends on this degrading, not throwing.
        return out.replace(/\{[a-zA-Z_]+\}/g, '');
      },
    };
    if (spec.system_context !== undefined) {
      agent.system_context = () => spec.system_context;
    }
    agents.set(spec.name, agent);
  }
  return agents;
}

const vector = JSON.parse(await readStdin());
const fixture = vector.fixture ?? {};
const request = vector.request ?? {};
const provider = new ScriptedProvider(vector.model_script);

// §2.1 and the rest of the request contract are checked by calling the real
// validator, not by restating it.
//
// This line used to read `String(request.user_input ?? '').trim()` with a
// comment explaining that the HTTP layer owns the check and the driver applies
// "the same rule". It was the same rule right up until the HTTP layer's rule
// changed. `1b94040` transliterated the brainstem's validation into
// `parseChatRequest` — array checking, role validation, and a flip making
// `user_input` authoritative over `message` — and the corpus stayed green,
// because the corpus was measuring this copy (#117).
//
// A driver that reimplements the thing under test can only ever confirm
// itself. `parseChatRequest` is what `server.ts:1421` calls on the real /chat
// path, so calling it here puts the request contract back on the measured path.
const parsedRequest = parseChatRequest(request);
if (!parsedRequest.ok) {
  process.stdout.write(JSON.stringify({
    __status: 400,
    body: { error: parsedRequest.error },
    __modelCalled: false,
    __rounds: 0,
  }));
  process.exit(0);
}
const userInput = parsedRequest.value.userInput;

const agents = buildAgents(fixture);
const assistant = new Assistant(agents, {
  name: 'openrappter',
  description: fixture.soul ?? '',
  provider,
  // Read from disk in normal operation; a CI runner has neither, and loading
  // them would make the result depend on the machine rather than the vector.
  loadWorkspaceContext: false,
  loadMemoryContext: false,
});

const sessionId = request.session_id
  ?? `${Math.random().toString(16).slice(2, 10)}-0000-4000-8000-${Date.now().toString(16).padStart(12, '0').slice(-12)}`;

// §5.3.10 checks that junk roles are dropped before the model call. This
// runtime keeps its own conversation map rather than taking history per
// request, so prior turns arrive through importConversation — which is where
// its role filter lives. Not calling it would have measured the driver rather
// than the runtime, and reported a filter that works as broken.
const priorHistory = request.conversation_history;
if (Array.isArray(priorHistory) && priorHistory.length) {
  assistant.importConversation(sessionId, priorHistory);
}

let envelope;
try {
  const result = await assistant.getResponse(
    userInput,
    undefined,
    undefined,
    sessionId,
  );
  envelope = buildChatEnvelope({
    content: result.content ?? '',
    sessionId,
    agentLogs: result.agentLogs ?? [],
    backendKind: 'scripted-model',
  });
} catch (error) {
  process.stdout.write(JSON.stringify({
    __status: 500,
    __error: `${error?.name ?? 'Error'}: ${error?.message ?? error}`,
    __rounds: provider.round,
  }));
  process.exit(0);
}

process.stdout.write(JSON.stringify({
  ...envelope,
  __status: 200,
  __rounds: provider.round,
  __outbound: provider.outbound,
  __toolsFirstCall: provider.toolsSeen[0] ?? null,
  __modelCalled: provider.round > 0,
}));
