# Model provider

`ModelProvider.complete` returns either final text or structured tool proposals.
Tool descriptions contain only names, descriptions, and JSON input schemas.
They do not carry permissions, callbacks, capabilities, or tool implementations.

`GitHubCopilotProvider` validates the GitHub Copilot boundary. Production supplies
`CopilotSdkTransport`, backed by the pinned official Node SDK and a fixed local
Copilot CLI stdio process (minimum CLI 1.0.83).
The adapter forwards only whitelisted request fields and explicitly disables
automatic tool execution. The transport must honor that contract and the abort
signal. `status()` reports actual SDK availability, authentication and model
inventory; it never substitutes a test response. Every request uses a fresh
empty-mode session, disables ambient context/features, supplies no executable
tools, denies all permissions, and verifies an empty offered tool set before
prompting. Session cleanup is scoped to that request. The app-owned Copilot home
and environment are explicit. There is no shell or secondary-provider fallback.

## Strict conversational drafting

`GitHubCopilotProvider.draft<T>` is a separate bounded seam for structured Twin
drafts. Supply a plain JSON Schema plus a local strict `parse` validator. Only
the schema and messages reach the SDK; validators, capabilities and executors
never do. The Copilot SDK uses the same empty-mode session and tool isolation
checks, with a JSON-schema response instruction. There is no claim that the
SDK supplies native constrained decoding: the local validator is mandatory,
and nonconforming output is rejected, never repaired into invented work.

Drafting pins `gpt-6-astra`, `reasoningEffort: "max"` and
`contextTier: "long_context"`. Ordinary worker completions selecting Astra
retain that same fixed profile. The adapter verifies the live authenticated model
inventory and advertised max-reasoning support before session creation. The
long tier is explicitly requested, not inferred from token counts; unsupported
session/tier configuration fails rather than silently downgrading.
`status().modelOptions` reports only SDK-supplied reasoning capabilities and
context limits, not fabricated tier availability.

Limits are 50 messages, 262,144 serialized message characters, a 65,536-character
JSON schema, 16,384 requested output tokens, and a response bounded by the
smaller of 131,072 characters or eight times the output-token budget. The SDK
additionally checks UTF-8 response bytes and observed token usage. Drafts accept
no tool messages/calls, always supply `tools: []`, and propagate cancellation.
The host applies tighter conversation and output limits and validates all
availability/ownership choices against its supplied context.

Both the adapter and runtime validate bounded JSON responses, tool names,
unique call IDs, and token usage. Validation is not authorization: only the
runtime's persistent policy and security-issued permits can allow an effect.
Tests inject transport/client seams and make no provider/network requests. See
[host setup](../../docs/LOCAL_PRODUCTION.md) for the supported SDK API, login
profile, failure behavior and verification boundaries.

```sh
npm run build --workspace @rapp-work/model-provider
npm test --workspace @rapp-work/model-provider
```
