# OuroborosAgent

Self-evolving agent that reads its own source, generates variants with new capabilities, and hot-loads them across generations.

## Evolution Process

1. Read current source code
2. Assess capabilities (word stats, sentiment, cipher, patterns, reflection)
3. Generate evolved variant
4. Hot-load the new version
5. Track lineage and trends

## Capability Scoring

See [[Capability Scoring Principles]] for the design rules:
- Graduated thresholds over binary checks (where appropriate)
- Inclusive boundaries (`>=`)
- Polarity-agnostic sentiment
- Quality = (passed / total) * 100

## Files
- `typescript/src/agents/OuroborosAgent.ts`
- Tests: `ouroboros.test.ts`

## Related
- [[LearnNewAgent]] | [[WatchmakerAgent]] | [[Agent Index]]

---

#agents #specialized #evolution
