# LLM Providers

openrappter supports multiple LLM backends through a unified provider interface.

## Available Providers

| Provider | Auth | Notes |
|----------|------|-------|
| **GitHub Copilot** (default) | GitHub token (device code) | No extra cost, full streaming |
| **Anthropic** | `ANTHROPIC_API_KEY` | Claude models |
| **OpenAI** | `OPENAI_API_KEY` | GPT-4 etc. |
| **Google Gemini** | `GEMINI_API_KEY` | Gemini models |
| **Ollama** | None (local) | Self-hosted |

All providers support OpenAI-compatible tool/function calling. Copilot provider has full SSE streaming with tool call accumulation.

## Provider Registry

```typescript
const providers = getAvailableProviders(); // checks API keys
const provider = getProvider('copilot');
```

## Files
- `typescript/src/providers/copilot.ts` — Streaming + token exchange
- `typescript/src/providers/anthropic.ts`
- `typescript/src/providers/openai.ts`
- `typescript/src/providers/gemini.ts`
- `typescript/src/providers/ollama.ts`
- `typescript/src/providers/registry.ts`

## Related
- [[Architecture Overview]]
- [[Getting Started]]

---

#architecture #providers
