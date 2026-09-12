# Model provider

`ModelProvider.complete` returns either final text or structured tool proposals.
Tool descriptions contain only names, descriptions, and JSON input schemas.
They do not carry permissions, callbacks, capabilities, or tool implementations.

`GitHubCopilotProvider` is the GitHub Copilot adapter seam. The host must supply
a `CopilotTransport` backed by its authenticated Copilot SDK/API connection.
The adapter forwards only whitelisted request fields and explicitly disables
automatic tool execution. The transport must honor that contract and the abort
signal. Authentication and SDK lifecycle belong to the host composition root.
There is no CLI-shell fallback or implicit provider.

Both the adapter and runtime validate bounded JSON responses, tool names,
unique call IDs, and token usage. Validation is not authorization: only the
runtime's persistent policy and security-issued permits can allow an effect.
Tests use fake transports and make no provider/network requests.

```sh
npm run build --workspace @rapp-work/model-provider
npm test --workspace @rapp-work/model-provider
```
