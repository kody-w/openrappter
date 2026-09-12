# Agent runtime

`AgentRuntime` requires a `WorkServicePort`, `ModelProvider`, an explicit trusted
tool registry, and finite host `RuntimeLimits`. It never scans files for workers.
`WorkServiceAgentDefinitions.save/load` stores and derives persistent definitions
through verified work commits. Only successful `agent.define` commands can
change these definitions; arbitrary tool-produced events cannot alter policy.

Each definition declares its sole workspace, enabled state, instructions,
model, exact tool allowlist, step/tool-call budgets, per-agent concurrency,
tool concurrency, duration, and output-token limit. Host limits can tighten but
never widen that policy. The runtime copies descriptions to the provider; it
does not give the provider capabilities, permits, or executors.

`run(capability, {scope, taskId, runId, input, signal})` durably records the start,
each model request, each authorized tool effect, and the terminal result.
Tool batches are policy/input-checked before any member runs. Tools receive
an intent-bound permit and the authenticated invocation capability, never a
provider-created grant. Tool adapters may call the computer broker's **separate**
computer history, returning `computerToolOutcome` for linkage into the agent
tool commit; they must not recursively commit to the locked agent workspace.

Run IDs are persistent idempotency keys. A recorded start without a terminal
is unresolved on restart, not resumable work. Cancellation/deadlines stop new
steps promptly. Unacknowledged in-flight work stays unresolved and retains its
real concurrency slot until it settles, even if an adapter ignores its signal.
`inspectRun` reads durable evidence rather than process-local progress.

```sh
npm run build --workspace @rapp-work/agent-runtime
npm test --workspace @rapp-work/agent-runtime
```
