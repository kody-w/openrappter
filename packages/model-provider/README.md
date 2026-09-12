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
