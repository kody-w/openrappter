# Soul Templates

10 prebuilt agent personas that shape how openrappter responds. Each template configures available agents, tone, and behavior.

## Available Templates

| Template | Icon | Category | Personality |
|----------|------|----------|-------------|
| **assistant** | dino | general | Default full agent access — all tools available |
| **coder** | laptop | development | Senior engineer — code-focused, precise |
| **reviewer** | magnifier | development | Code review specialist — thorough, constructive |
| **researcher** | microscope | research | Searches, reads, synthesizes — citation-oriented |
| **analyst** | chart | research | Data to insights — structured, evidence-based |
| **ops** | wrench | operations | Monitors, heals, deploys — reliability-focused |
| **scheduler** | timer | operations | Automates repeating tasks — cron-oriented |
| **narrator** | microphone | creative | Voice-first via TTS — storytelling, expressive |
| **oracle** | crystal | creative | Meta-AI that evolves agents — philosophical |
| **companion** | speech | creative | Warm conversational AI — empathetic, casual |

## Configuration

Set in `~/.openrappter/workspace/IDENTITY.md` or via config:

```yaml
# ~/.openrappter/config.yaml
soul: coder
```

## How Templates Work

Each template defines:
1. **Available agents** — which tools the AI can use
2. **System prompt** — personality and communication style
3. **Response preferences** — brief vs detailed, technical vs casual

Templates are stored in `typescript/src/gateway/soul-templates/`.

## Related
- [[Getting Started]]
- [[Config System]]
- [[Architecture Overview]]

---

#guides #personas
